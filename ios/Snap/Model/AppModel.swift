import Foundation
import Observation
import UIKit

/// Owns the session, the API, the workout sync, and the two polling loops.
/// Views read from it and call into it; nothing else holds state.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case onboarding, linking, live }

    private(set) var phase: Phase = .onboarding
    private(set) var state: SnapState?
    private(set) var events: [TraceEvent] = []
    private(set) var name = ""
    private(set) var linkCode = ""
    private(set) var contact: OnboardResponse.Contact?
    private(set) var isWorking = false

    /// Shown in the debug panel only. The main screen never puts an error in front of a judge.
    var lastError: String?

    #if DEBUG
    /// Verdict from the `SNAP_HKDIAG` launch hook, read by the UI test. Nil in every
    /// ordinary run, and rendered invisibly — it is a test channel, not a feature.
    private(set) var hkDiagnostic: String?
    #endif

    private enum Key {
        static let name = "name"
        static let linkCode = "linkCode"
        static let telegram = "snapTelegram"
        static let imessage = "snapIMessage"
        static let all = [name, linkCode, telegram, imessage]
    }

    /// New events are shown one at a time so the feed reads like thinking, not like a refresh.
    private static let eventStagger = Duration.milliseconds(350)

    /// `/trace` returns at most this many events per call. A full page means there is
    /// more waiting, so poll again immediately instead of sitting out the interval.
    private static let traceBatchLimit = 200

    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private var api: any SnapAPI
    @ObservationIgnored private let sync: WorkoutSync
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var authFailed = false

    @ObservationIgnored private var pending: [TraceEvent] = []
    @ObservationIgnored private var lastEventId: Int?
    @ObservationIgnored private var drainTask: Task<Void, Never>?
    @ObservationIgnored private var drainGeneration = 0
    @ObservationIgnored private var stateTask: Task<Void, Never>?
    @ObservationIgnored private var traceTask: Task<Void, Never>?

    init() {
        let token = Keychain.token
        let api = Config.makeAPI(token: token)
        self.token = token
        self.api = api
        self.sync = WorkoutSync(api: api)
        sync.onError = { [weak self] message in self?.lastError = message }
    }

    // MARK: - Lifecycle

    func start() async {
        guard !started else { return }
        started = true

        name = defaults.string(forKey: Key.name) ?? ""
        linkCode = defaults.string(forKey: Key.linkCode) ?? ""
        let telegram = defaults.string(forKey: Key.telegram)
        let imessage = defaults.string(forKey: Key.imessage)
        if telegram != nil || imessage != nil {
            contact = .init(telegram: telegram, imessage: imessage)
        }

        observeLifecycle()

        #if DEBUG
        // `SNAP_PHASE=linking|live` drops straight onto a screen against MockAPI, and
        // `SNAP_TIMEWARP=1` pushes the clock past the deadline the way the debug panel does.
        let env = ProcessInfo.processInfo.environment
        // `SNAP_HKDIAG=1` saves a simulated workout on launch and prints what would be
        // POSTed. Exists so the one bit the demo turns on — whether HealthKit stamps
        // `wasUserEntered` on a workout we build — can be checked on a simulator instead
        // of guessed at, or discovered on stage.
        if env["SNAP_HKDIAG"] == "1" {
            Task {
                await sync.requestAuthorization()
                let result = await sync.diagnoseSimulatedWorkout()
                print(result)
                hkDiagnostic = result
                // Also on disk, so the verdict survives the app being killed at the end
                // of a UI test run. UserDefaults would not — it flushes lazily.
                if let documents = FileManager.default.urls(
                    for: .documentDirectory, in: .userDomainMask
                ).first {
                    try? Data(result.utf8).write(
                        to: documents.appendingPathComponent("hkdiag.txt")
                    )
                }
            }
        }
        switch env["SNAP_PHASE"] {
        case "linking":
            name = "Ryan"
            linkCode = "4821"
            contact = .init(telegram: "@snap_bro_bot", imessage: "+15555550123")
            phase = .linking
            return
        case "live":
            name = "Ryan"
            token = "debug"
            // Force the mock explicitly: `token` is not a real credential, so against a
            // deployed Worker this would 401 immediately.
            api = MockAPI.shared
            sync.setAPI(api)
            phase = .live
            startPolling()
            if env["SNAP_TIMEWARP"] == "1" {
                Task { await timewarpToCheck() }
            }
            return
        default:
            break
        }
        #endif

        guard token != nil else {
            phase = .onboarding
            return
        }
        phase = .linking
        sync.start()
        startPolling()
    }

    /// HealthKit permission is asked for from the onboarding button. Denial still continues —
    /// the app just won't sync.
    func requestHealthAuthorization() async {
        await sync.requestAuthorization()
    }

    func onboard(name rawName: String, goal: Int) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }

        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        let request = OnboardRequest(
            name: name,
            weeklyGoal: goal,
            timezone: TimeZone.current.identifier
        )

        do {
            let response = try await api.onboard(request)

            token = response.token
            Keychain.token = response.token
            self.name = name
            linkCode = response.linkCode
            contact = response.snapContact

            defaults.set(name, forKey: Key.name)
            defaults.set(response.linkCode, forKey: Key.linkCode)
            defaults.set(response.snapContact.telegram, forKey: Key.telegram)
            defaults.set(response.snapContact.imessage, forKey: Key.imessage)

            // Rebuild with the token so everything after this is authenticated.
            api = Config.makeAPI(token: token)
            sync.setAPI(api)

            phase = .linking
            sync.start()
            startPolling()
        } catch {
            lastError = describe(error)
        }
    }

    /// Called after the debug panel changes the server URL or debug key.
    func reloadAPI() {
        authFailed = false
        api = Config.makeAPI(token: token)
        sync.setAPI(api)
        clearFeed()
        state = nil
        startPolling()
    }

    func reset() {
        stopPolling()
        sync.stop()
        Keychain.token = nil
        WorkoutSync.clearAnchor()
        Key.all.forEach { defaults.removeObject(forKey: $0) }

        authFailed = false
        token = nil
        state = nil
        name = ""
        linkCode = ""
        contact = nil
        lastError = nil
        clearFeed()

        api = Config.makeAPI(token: nil)
        sync.setAPI(api)
        phase = .onboarding
    }

    // MARK: - Debug actions

    func timewarpToCheck() async {
        let checkAt = state?.openCommitment?.checkAt ?? Date()
        await attempt { try await $0.timewarp(to: checkAt.addingTimeInterval(60)) }
    }

    func resetClock() async {
        await attempt { try await $0.timewarp(to: nil) }
    }

    func seedDemo() async {
        await attempt { try await $0.seed() }
    }

    func saveSimulatedWorkout() async {
        do {
            try await sync.saveSimulatedWorkout()
        } catch {
            lastError = describe(error)
        }
    }

    // MARK: - Polling

    private func startPolling() {
        // A dead token fails identically forever, including after a trip to the
        // background, so this stays stopped until the session is rebuilt.
        guard token != nil, !authFailed else { return }
        stopPolling()

        stateTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshState()
                try? await Task.sleep(for: .seconds(2))
            }
        }
        traceTask = Task { [weak self] in
            while !Task.isCancelled {
                let moreWaiting = await self?.refreshTrace() ?? false
                if !moreWaiting {
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
    }

    private func stopPolling() {
        stateTask?.cancel()
        traceTask?.cancel()
        stateTask = nil
        traceTask = nil
    }

    private func refreshState() async {
        do {
            let state = try await api.state()
            self.state = state
            // Onboarding is driven by the token, not by the server.
            if phase != .onboarding {
                phase = state.linked ? .live : .linking
            }
        } catch {
            handle(error)
        }
    }

    /// Returns true when a full page came back, meaning more is already waiting.
    private func refreshTrace() async -> Bool {
        do {
            let events = try await api.trace(since: lastEventId)
            let cursor = lastEventId
            ingest(events)
            // Only chase the next page if the cursor actually moved, so a server that
            // keeps returning the same page can't spin this loop.
            return events.count >= Self.traceBatchLimit && lastEventId != cursor
        } catch {
            handle(error)
            return false
        }
    }

    /// A dead token fails every call identically, so stop rather than spraying the same
    /// error once a second. Recovery is "reset app" in the debug panel — deliberately not
    /// automatic, because silently wiping the session mid-demo is worse than a frozen screen.
    private func handle(_ error: Error) {
        lastError = describe(error)
        if let apiError = error as? APIError, apiError.isUnauthorized {
            authFailed = true
            stopPolling()
        }
    }

    // MARK: - Trace feed

    /// Queues whatever arrived; the drain shows them one at a time even when a single
    /// response carries several.
    private func ingest(_ incoming: [TraceEvent]) {
        let floor = lastEventId ?? 0
        let fresh = incoming.filter { $0.id > floor }.sorted { $0.id < $1.id }
        guard !fresh.isEmpty else { return }

        pending.append(contentsOf: fresh)
        lastEventId = fresh.last?.id
        startDraining()
    }

    private func startDraining() {
        guard drainTask == nil else { return }
        // A drain cancelled mid-sleep must not clear the handle of the one that replaced it.
        let generation = drainGeneration
        drainTask = Task { [weak self] in
            while true {
                guard let self, !Task.isCancelled, !self.pending.isEmpty else { break }
                self.events.append(self.pending.removeFirst())
                try? await Task.sleep(for: Self.eventStagger)
            }
            if let self, self.drainGeneration == generation { self.drainTask = nil }
        }
    }

    private func clearFeed() {
        drainGeneration += 1
        drainTask?.cancel()
        drainTask = nil
        pending.removeAll()
        events.removeAll()
        lastEventId = nil
    }

    // MARK: - Plumbing

    private func observeLifecycle() {
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.startPolling() }
        }
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stopPolling() }
        }
    }

    private func attempt(_ work: (any SnapAPI) async throws -> Void) async {
        do {
            try await work(api)
        } catch {
            lastError = describe(error)
        }
    }

    private func describe(_ error: Error) -> String {
        let time = Date.now.formatted(date: .omitted, time: .standard)
        return "\(time) · \(error.localizedDescription)"
    }
}
