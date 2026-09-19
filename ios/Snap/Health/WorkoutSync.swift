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
    private static let workoutType = HKObjectType.workoutType()

    /// Only workouts from the last week are ever interesting to Snap, so every query is
    /// bounded to it — the same predicate on every drain keeps the anchor lineage
    /// consistent instead of mixing a bounded first fetch with unbounded later ones.
    private static let lookback: TimeInterval = 7 * 86_400

    /// A failed POST is retried a couple of times before the anchor is left for the
    /// next drain. Short, because on a background wake iOS gives us seconds, not minutes.
    private static let retryDelays: [Duration] = [.seconds(1.5), .seconds(3)]

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
            withStart: Date().addingTimeInterval(-Self.lookback),
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

    // MARK: - Debug

    /// A 45-minute strength workout ending now, for demoing without an Apple Watch.
    @discardableResult
    func saveSimulatedWorkout() async throws -> HKWorkout? {
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .traditionalStrengthTraining

        let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: .local())
        let end = Date()
        try await builder.beginCollection(at: end.addingTimeInterval(-45 * 60))
        try await builder.endCollection(at: end)
        let workout = try await builder.finishWorkout()

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
