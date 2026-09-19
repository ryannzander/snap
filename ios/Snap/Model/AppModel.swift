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
        /// Remembered so a cold launch of a linked phone opens on the brain screen
        /// instead of flashing the link code until the first `/state` lands.
        static let linked = "linked"
        static let all = [name, linkCode, telegram, imessage, linked]
    }

    /// New events are shown one at a time so the feed reads like thinking, not like a refresh.
    private static let eventStagger = Duration.milliseconds(350)

    /// A backlog (seeded history, a reconnect replaying the feed) drains at this pace
    /// instead, so fifty old events don't turn into seventeen seconds of progress bar.
    private static let backlogStagger = Duration.milliseconds(60)
    private static let backlogThreshold = 8

    /// `/trace` returns at most this many events per call. A full page means there is
    /// more waiting, so poll again immediately instead of sitting out the interval.
    private static let traceBatchLimit = 200

    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private var api: any SnapAPI
    @ObservationIgnored private let sync: WorkoutSync
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var authFailed = false
    @ObservationIgnored private var lifecycleObservers: [any NSObjectProtocol] = []

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

    /// True when the app is talking to the scripted mock rather than a server.
    var isMock: Bool { api is MockAPI }

    /// True until the HealthKit sheet has been answered — the one "not syncing" state
    /// the app can actually name, since HealthKit hides read denial. Stored (not read
    /// through `sync`) so the brain screen's notice goes away when it changes.
    private(set) var isHealthAccessUndetermined = false

    private func refreshHealthAccess() {
        let undetermined = sync.isAuthorizationUndetermined
        if undetermined != isHealthAccessUndetermined {
            isHealthAccessUndetermined = undetermined
        }
    }

    // MARK: - Lifecycle

    /// Registers the HealthKit observer as early as possible. `start()` runs from the
    /// root view's `.task`, which a background launch for a HealthKit delivery may never
    /// reach; the observer query has to be re-executed on every launch or iOS stops
    /// delivering. Safe to call more than once.
    func startWorkoutSyncIfOnboarded() {
        guard token != nil else { return }
        sync.start()
    }

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
        refreshHealthAccess()

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
        // Start where we were last time; the first `/state` corrects it either way.
        phase = defaults.bool(forKey: Key.linked) ? .live : .linking
        sync.start()
        startPolling()
    }

    /// HealthKit permission is asked for from the onboarding button. Denial still continues —
    /// the app just won't sync.
    func requestHealthAuthorization() async {
        await sync.requestAuthorization()
        refreshHealthAccess()
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
            if let keychainError = Keychain.lastWriteError {
                // The session works for now but won't survive a relaunch.
                lastError = describe(keychainError)
            } else {
                lastError = nil
            }
            self.name = name
            linkCode = response.linkCode
            contact = response.snapContact

            defaults.set(name, forKey: Key.name)
            defaults.set(response.linkCode, forKey: Key.linkCode)
            defaults.set(response.snapContact.telegram, forKey: Key.telegram)
            defaults.set(response.snapContact.imessage, forKey: Key.imessage)
            defaults.set(false, forKey: Key.linked)

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

        // The mock is a process-wide singleton; without this a second run-through
        // replays a finished loop instantly.
        if let mock = api as? MockAPI {
            Task { await mock.reset() }
        }

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

    /// Seeding wipes the server's trace and restarts its ids at 1, so the cursor this
    /// app holds would point past everything new and the feed would go silent for the
    /// rest of the session. Drop the cursor with it.
    func seedDemo() async {
        do {
            try await api.seed()
            clearFeed()
        } catch {
            lastError = describe(error)
        }
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
                guard let self else { break }
                await self.refreshState()
                try? await Task.sleep(for: .seconds(2))
            }
        }
        traceTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { break }
                let moreWaiting = await self.refreshTrace()
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
            guard !Task.isCancelled else { return }
            // Unchanged state is not republished: every assignment invalidates the whole
            // brain screen, and this runs twice a second for the life of the app.
            if state != self.state {
                self.state = state
            }
            // Onboarding is driven by the token, not by the server.
            if phase != .onboarding {
                phase = state.linked ? .live : .linking
                if defaults.bool(forKey: Key.linked) != state.linked {
                    defaults.set(state.linked, forKey: Key.linked)
                }
            }
        } catch {
            handle(error)
        }
    }

    /// Returns true when a full page came back, meaning more is already waiting.
    private func refreshTrace() async -> Bool {
        do {
            let events = try await api.trace(since: lastEventId)
            guard !Task.isCancelled else { return false }
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
        // Our own cancellation (background, reconnect) is not an error worth showing;
        // it would sit in the debug panel masking whatever someone is trying to read.
        if Self.isCancellation(error) { return }
        lastError = describe(error)
        if let apiError = error as? APIError, apiError.isUnauthorized {
            authFailed = true
            stopPolling()
        }
    }

    private static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let urlError = error as? URLError, urlError.code == .cancelled { return true }
        return false
    }

    // MARK: - Trace feed

    /// Queues whatever arrived; the drain shows them one at a time even when a single
    /// response carries several.
    private func ingest(_ incoming: [TraceEvent]) {
        // `since` is exclusive, so anything at or below the cursor was already shown.
        // Before the first page there is no cursor — an event with id 0 must still count.
        let floor = lastEventId ?? Int.min
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
                let stagger = self.pending.count > Self.backlogThreshold
                    ? Self.backlogStagger
                    : Self.eventStagger
                try? await Task.sleep(for: stagger)
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
        guard lifecycleObservers.isEmpty else { return }
        let center = NotificationCenter.default
        lifecycleObservers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.startPolling()
                self.refreshHealthAccess()
                // A POST that failed while we were away left the anchor where it was;
                // HealthKit will not fire again for it, so this is the retry.
                if self.token != nil {
                    Task { await self.sync.drain() }
                }
            }
        })
        lifecycleObservers.append(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.stopPolling() }
        })
    }

    private func attempt(_ work: (any SnapAPI) async throws -> Void) async {
        do {
            try await work(api)
        } catch {
            lastError = describe(error)
        }
    }

    private func describe(_ error: Error) -> String {
        describe(error.localizedDescription)
    }

    private func describe(_ message: String) -> String {
        let time = Date.now.formatted(date: .omitted, time: .standard)
        return "\(time) · \(message)"
    }
}
