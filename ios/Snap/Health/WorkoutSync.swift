import Foundation
import HealthKit

/// Watches HealthKit for workouts and POSTs them as they appear.
///
/// The backend dedupes on `hkUuid`, so resending is free — which is the whole error
/// strategy here: if a POST fails the anchor stays put and the next fire sends it again.
@MainActor
final class WorkoutSync {
    private static let anchorKey = "hkAnchor"
    private static let workoutType = HKObjectType.workoutType()

    /// Surfaced in the debug panel only.
    var onError: ((String) -> Void)?

    private let store = HKHealthStore()
    private var api: any SnapAPI
    private var observer: HKObserverQuery?
    private var draining = false

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
    }

    /// Fetch everything since the saved anchor, POST it, and only then move the anchor.
    func drain() async {
        guard Self.isAvailable, !draining else { return }
        draining = true
        defer { draining = false }

        let anchor = Self.loadAnchor()
        do {
            let (workouts, newAnchor) = try await fetch(from: anchor)
            if !workouts.isEmpty {
                try await api.postWorkouts(workouts)
            }
            Self.saveAnchor(newAnchor)
        } catch {
            // Anchor untouched: the next observer fire resends.
            onError?("workout sync: \(error.localizedDescription)")
        }
    }

    private func fetch(from anchor: HKQueryAnchor?) async throws -> ([WorkoutDTO], HKQueryAnchor?) {
        // First run has no anchor, so bound it to the last week instead of all of history.
        let predicate: NSPredicate? = anchor == nil
            ? HKQuery.predicateForSamples(withStart: Date().addingTimeInterval(-7 * 86_400), end: nil)
            : nil

        return try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: Self.workoutType,
                predicate: predicate,
                anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, samples, _, newAnchor, error in
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
    func saveSimulatedWorkout() async throws {
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .traditionalStrengthTraining

        let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: .local())
        let end = Date()
        try await builder.beginCollection(at: end.addingTimeInterval(-45 * 60))
        try await builder.endCollection(at: end)
        _ = try await builder.finishWorkout()

        await drain()
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

private extension WorkoutDTO {
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
            activeKcal: kcal.map { Int($0.rounded()) }
        )
    }
}
