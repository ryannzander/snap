import Foundation
import HealthKit

/// Watches HealthKit for workouts and POSTs them as they appear.
///
/// The backend dedupes on `hkUuid`, so resending is free — which is the whole error
/// strategy here: if a POST fails the anchor stays put and the next drain sends it again.
/// A drain runs on every observer fire, on launch, when the app comes to the foreground,
/// and after the debug panel saves a simulated workout.
@MainActor
final class WorkoutSync {
    private static let anchorKey = "hkAnchor"
    private static let floorKey = "hkSyncFloor"
    private static let workoutType = HKObjectType.workoutType()

    /// Only workouts from the last week are ever interesting to Snap, so every query is
    /// bounded to it. The window rolls forward with each drain; that is fine because the
    /// backend dedupes on `hkUuid` and nothing older than a week can matter.
    private static let lookback: TimeInterval = 7 * 86_400

    /// A failed POST is retried a couple of times before the anchor is left for the
    /// next drain. Short, because the observer's completion handler waits on this and
    /// a background wake gives us seconds, not minutes.
    private static let retryDelays: [Duration] = [.seconds(1), .seconds(2)]

    /// Surfaced in the debug panel only.
    var onError: ((String) -> Void)?

    private let store = HKHealthStore()
    private var api: any SnapAPI
    private var observer: HKObserverQuery?
    private var draining = false
    private var needsRedrain = false

    init(api: any SnapAPI) {
        self.api = api
    }

    static var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    /// The debug panel can point the app at a different server without restarting the queries.
    func setAPI(_ api: any SnapAPI) {
        self.api = api
    }

    // MARK: - Authorization

    /// Read workouts and active energy; write workouts so the debug panel can save a fake one.
    /// Denial is not an error here — the app just won't sync.
    func requestAuthorization() async {
        guard Self.isAvailable else { return }
        let read: Set<HKObjectType> = [Self.workoutType, HKQuantityType(.activeEnergyBurned)]
        let share: Set<HKSampleType> = [HKObjectType.workoutType()]
        do {
            try await store.requestAuthorization(toShare: share, read: read)
        } catch {
            onError?("healthkit auth: \(error.localizedDescription)")
        }
    }

    /// True until the HealthKit sheet has been answered. HealthKit hides *read* denial,
    /// so this is the one state the app can name: "you were never asked".
    var isAuthorizationUndetermined: Bool {
        guard Self.isAvailable else { return false }
        return store.authorizationStatus(for: Self.workoutType) == .notDetermined
    }

    // MARK: - Observing

    func start() {
        guard Self.isAvailable, observer == nil else { return }

        let query = HKObserverQuery(sampleType: Self.workoutType, predicate: nil) { [weak self] _, completion, error in
            Task { @MainActor in
                if let error { self?.onError?("observer: \(error.localizedDescription)") }
                await self?.drain()
                // Every fire must be acknowledged, failure included, or iOS stops delivering.
                completion()
            }
        }
        observer = query
        store.execute(query)

        store.enableBackgroundDelivery(for: Self.workoutType, frequency: .immediate) { [weak self] _, error in
            guard let error else { return }
            Task { @MainActor in self?.onError?("background delivery: \(error.localizedDescription)") }
        }

        Task { await drain() }
    }

    func stop() {
        if let observer {
            store.stop(observer)
            self.observer = nil
        }
        guard Self.isAvailable else { return }
        // Otherwise iOS keeps launching the app in the background for every workout
        // after a reset, with nobody there to acknowledge the delivery.
        store.disableBackgroundDelivery(for: Self.workoutType) { _, _ in }
    }

    /// Fetch everything since the saved anchor, POST it, and only then move the anchor.
    ///
    /// A fire that lands while a drain is already running is not dropped: the running
    /// drain goes round again, because the new sample was written after its query ran.
    func drain() async {
        guard Self.isAvailable else { return }
        if draining {
            needsRedrain = true
            return
        }
        draining = true
        defer { draining = false }

        repeat {
            needsRedrain = false
            await drainOnce()
        } while needsRedrain
    }

    private func drainOnce() async {
        let anchor = Self.loadAnchor()
        do {
            let (workouts, newAnchor) = try await fetch(from: anchor)
            if !workouts.isEmpty {
                try await post(workouts)
            }
            Self.saveAnchor(newAnchor)
        } catch is CancellationError {
            // Ours (app going away mid-drain), not a sync failure. Anchor untouched.
        } catch {
            // Anchor untouched: the next drain resends.
            onError?("workout sync: \(error.localizedDescription)")
        }
    }

    private func post(_ workouts: [WorkoutDTO]) async throws {
        var attempt = 0
        while true {
            do {
                try await api.postWorkouts(workouts)
                return
            } catch {
                // Don't hammer a dead token, and don't retry our own cancellation.
                if let apiError = error as? APIError, apiError.isUnauthorized { throw error }
                if error is CancellationError { throw error }
                guard attempt < Self.retryDelays.count else { throw error }
                try await Task.sleep(for: Self.retryDelays[attempt])
                attempt += 1
            }
        }
    }

    private func fetch(from anchor: HKQueryAnchor?) async throws -> ([WorkoutDTO], HKQueryAnchor?) {
        let predicate = HKQuery.predicateForSamples(
            withStart: Self.windowStart(),
            end: nil
        )

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: Self.workoutType,
                predicate: predicate,
                anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, samples, _, newAnchor, error in
                // Deletions (the third argument) are deliberately ignored: a workout
                // removed from Health after it released a stake must not un-release it.
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let workouts = (samples as? [HKWorkout] ?? [])
                    .sorted { $0.startDate < $1.startDate }
                    .map(WorkoutDTO.init(workout:))
                continuation.resume(returning: (workouts, newAnchor))
            }
            store.execute(query)
        }
    }

    // MARK: - Sessions (no Watch)

    private static let sessionKey = "sessionStartedAt"

    /// When the in-app session started, or nil. Only the start instant is kept, and it
    /// lives in UserDefaults, so a relaunch mid-session loses nothing — HealthKit is
    /// not touched until the session ends.
    static var sessionStartedAt: Date? {
        get { UserDefaults.standard.object(forKey: sessionKey) as? Date }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: sessionKey)
            } else {
                UserDefaults.standard.removeObject(forKey: sessionKey)
            }
        }
    }

    /// Snap times the session itself, for people without a Watch. Same evidence tier as
    /// Hevy or Strava: a real start and end, written through the workout builder, so
    /// it arrives recorded rather than hand-entered. The backend's 30-minute floor
    /// still applies — a two-minute session does not release anything.
    func startSession() {
        Self.sessionStartedAt = Date()
    }

    /// Writes the session as a strength-training workout from the recorded start to
    /// now, then syncs it. The start is only cleared once the write succeeds, so a
    /// denied HealthKit permission can be fixed and the same session ended again.
    ///
    /// Below the floor this refuses instead of writing. "done" used to end the
    /// session whenever it was tapped: the short workout went to HealthKit, the
    /// backend dropped it as under 30 min, and the session was gone — nothing to
    /// resume and nothing on screen to say why. Deliberately throwing the session
    /// away is what "cancel" is for.
    @discardableResult
    func endSession() async throws -> HKWorkout? {
        guard let start = Self.sessionStartedAt else { return nil }
        let elapsed = Date().timeIntervalSince(start)
        guard elapsed >= Self.minimumSessionSec else {
            throw SessionError.tooShort(remaining: Self.minimumSessionSec - elapsed)
        }
        let workout = try await saveStrengthTraining(from: start, to: Date())
        Self.sessionStartedAt = nil
        await drain()
        return workout
    }

    /// The backend's `MIN_WORKOUT_SEC`. A session under this releases nothing, so
    /// there is no point writing it.
    ///
    /// It is a fraud floor, not an effort bar. It was 30 minutes, which made it
    /// both: someone who drove to the gym, warmed up, felt terrible and left
    /// after twenty minutes was told their session did not count and lost their
    /// stake — and turning up is the behaviour the stake exists to buy. What
    /// they were *aiming* for is the intensity target (30/45/60), which Snap
    /// says out loud and never enforces with money.
    static let minimumSessionSec: TimeInterval = 15 * 60

    /// The same number, for anything a person reads.
    ///
    /// Every string that quotes the floor interpolates this instead of spelling
    /// it out. The backend moved to 15 and three hardcoded "30 min" strings in
    /// the app did not, so the phone spent hours contradicting the pitch, the
    /// README, and the button it was greying out.
    static var minimumSessionMinutes: Int { Int(minimumSessionSec / 60) }

    enum SessionError: LocalizedError {
        case tooShort(remaining: TimeInterval)

        var errorDescription: String? {
            switch self {
            case let .tooShort(remaining):
                let minutes = Int(ceil(remaining / 60))
                return "\(minutes) more min before this one counts — or cancel it"
            }
        }
    }

    func cancelSession() {
        Self.sessionStartedAt = nil
    }

    /// Demo only: moves the session's start back by `seconds` so "done" produces a
    /// workout past the backend's 30-minute floor without waiting it out. Starts a
    /// session first if none is running. The workout that results is still written
    /// through the builder, so it releases a stake exactly like a real one.
    func warpSession(back seconds: TimeInterval) {
        let start = Self.sessionStartedAt ?? Date()
        Self.sessionStartedAt = start.addingTimeInterval(-seconds)
    }

    private func saveStrengthTraining(from start: Date, to end: Date) async throws -> HKWorkout? {
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .traditionalStrengthTraining

        let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: .local())
        try await builder.beginCollection(at: start)
        try await builder.endCollection(at: end)
        return try await builder.finishWorkout()
    }

    // MARK: - Debug

    /// A 45-minute strength workout ending now, for demoing without an Apple Watch.
    @discardableResult
    func saveSimulatedWorkout() async throws -> HKWorkout? {
        let end = Date()
        let workout = try await saveStrengthTraining(from: end.addingTimeInterval(-45 * 60), to: end)
        await drain()
        return workout
    }

    #if DEBUG
    /// Saves a simulated workout and reports exactly what would go over the wire.
    ///
    /// Without an Apple Watch this is the on-stage path, and the whole demo turns on one
    /// bit: if HealthKit stamps `wasUserEntered` on a workout this app builds, the backend
    /// reads it as typed in by hand and the stake can never release. Reasoning about that
    /// from the docs is not the same as watching it come back.
    func diagnoseSimulatedWorkout() async -> String {
        do {
            guard let workout = try await saveSimulatedWorkout() else {
                return "HKDIAG fail: finishWorkout returned nil"
            }
            let dto = WorkoutDTO(workout: workout)
            let verdict = dto.wasUserEntered
                ? "FAIL — arrives hand-entered, the stake can never release"
                : "PASS — releases a stake"
            return """
            HKDIAG type=\(dto.type) durationSec=\(dto.durationSec) \
            wasUserEntered=\(dto.wasUserEntered) source=\(dto.source)
            HKDIAG metadata=\(workout.metadata.map { String(describing: $0) } ?? "nil")
            HKDIAG \(verdict)
            """
        } catch {
            return "HKDIAG fail: \(error.localizedDescription)"
        }
    }
    #endif

    // MARK: - The window

    /// Where a sync starts looking.
    ///
    /// Normally a week back, so a new install's "2/4 this week" is true on the day
    /// it is installed rather than starting at zero and lying.
    ///
    /// After a reset it is the moment of the reset instead. Reset drops the anchor,
    /// and an anchorless query against a week-wide predicate hands the brand-new
    /// account every workout of the last seven days — so you would wipe the app,
    /// onboard again, and Snap would open already knowing about this morning's
    /// session. Nothing survived the reset; the phone put it back. The floor is what
    /// makes a fresh start actually fresh.
    static func windowStart(now: Date = Date()) -> Date {
        let rolling = now.addingTimeInterval(-lookback)
        guard let floor = syncFloor else { return rolling }
        return max(rolling, floor)
    }

    /// Set on reset, and never cleared — a later onboarding is still the same phone
    /// on the same day, and the workouts before it are still not this account's.
    static var syncFloor: Date? {
        get { UserDefaults.standard.object(forKey: floorKey) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: floorKey) }
    }

    // MARK: - Anchor

    private static func loadAnchor() -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: anchorKey) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private static func saveAnchor(_ anchor: HKQueryAnchor?) {
        guard let anchor,
              let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
        else { return }
        UserDefaults.standard.set(data, forKey: anchorKey)
    }

    static func clearAnchor() {
        UserDefaults.standard.removeObject(forKey: anchorKey)
    }

    // MARK: - Activity types

    /// The `HKWorkoutActivityType` case name, which is what the backend expects.
    nonisolated static func name(for type: HKWorkoutActivityType) -> String {
        switch type {
        case .traditionalStrengthTraining: "traditionalStrengthTraining"
        case .functionalStrengthTraining: "functionalStrengthTraining"
        case .coreTraining: "coreTraining"
        case .crossTraining: "crossTraining"
        case .highIntensityIntervalTraining: "highIntensityIntervalTraining"
        case .running: "running"
        case .walking: "walking"
        case .hiking: "hiking"
        case .cycling: "cycling"
        case .rowing: "rowing"
        case .elliptical: "elliptical"
        case .stairClimbing: "stairClimbing"
        case .swimming: "swimming"
        case .yoga: "yoga"
        case .pilates: "pilates"
        case .mixedCardio: "mixedCardio"
        default: "other"
        }
    }
}

extension WorkoutDTO {
    /// Internal (not private) so a unit test can check what a real `HKWorkout` turns into.
    init(workout: HKWorkout) {
        let kcal = workout.statistics(for: HKQuantityType(.activeEnergyBurned))?
            .sumQuantity()?
            .doubleValue(for: .kilocalorie())

        self.init(
            hkUuid: workout.uuid.uuidString,
            type: WorkoutSync.name(for: workout.workoutActivityType),
            start: workout.startDate,
            end: workout.endDate,
            durationSec: Int(workout.duration.rounded()),
            activeKcal: kcal.map { Int($0.rounded()) },
            source: workout.sourceRevision.source.bundleIdentifier,
            wasUserEntered: workout.metadata?[HKMetadataKeyWasUserEntered] as? Bool ?? false
        )
    }
}
