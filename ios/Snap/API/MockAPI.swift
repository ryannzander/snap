import Foundation

/// Plays the whole loop with no backend, so the UI can be built and polished before the
/// Worker exists. Used whenever `Config.baseURL` is empty.
///
/// The trace script runs on a wall clock started by the first `trace` call, one step at a
/// time. State (stake, weekly count, commitment status) follows the script, so the brain
/// screen sees the same transitions it would see for real.
actor MockAPI: SnapAPI {
    static let shared = MockAPI()

    /// A syntactically valid devnet signature. It points at no real transaction —
    /// there is no chain behind the mock — but it renders and truncates like one.
    static let mockSignature =
        "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCFFzVRtQJC5Zt8F2nWYdKEtmSTfCFnLcqLp1hZmCQtGmZ9tZ8Ab"

    private struct Step {
        let kind: TraceEvent.Kind
        let summary: String

        init(_ kind: TraceEvent.Kind, _ summary: String) {
            self.kind = kind
            self.summary = summary
        }
    }

    private static let script: [Step] = [
        Step(.commitmentCreated, "gym at 7 · 0.05 SOL on it"),
        Step(.stakeHeld,         "0.05 SOL locked · 4xK…9fQ"),
        Step(.alarmFired,        "7:24 — checking on gym at 7"),
        Step(.context,           "no workout today · skipped yesterday · 2/4 this week · 0.05 SOL staked"),
        Step(.decision,          "intervene — firm"),
        Step(.messageSent,       "bro"),
        Step(.messageSent,       "7:24 and no workout 😭"),
        Step(.messageSent,       "you said no excuses today"),
        Step(.messageReceived,   "homework bro"),
        Step(.decision,          "one reschedule left · allow 30 min"),
        Step(.messageSent,       "30 mins then. push day. go."),
        Step(.workoutDetected,   "strength training started"),
        Step(.stakeReleased,     "0.05 SOL back in your wallet"),
        Step(.messageSent,       "that's my guy"),
    ]

    private static let stepInterval: TimeInterval = 1.2
    private static let alarmStep = 2
    private static let workoutStep = 11

    /// The link screen "receives the text" this long after onboarding. Anchored to the
    /// onboard call, not process launch: the mock is a singleton built at launch, and
    /// clicking through onboarding takes longer than any delay measured from there.
    private static let linkDelay: TimeInterval = 6

    private var dueAt: Date
    private var onboardedAt: Date?
    private var scriptStartedAt: Date?
    private var emitted: [TraceEvent] = []

    init() {
        dueAt = Date().addingTimeInterval(120)
    }

    /// Back to the top of the script. `AppModel.reset()` calls this so a second
    /// run-through of the demo doesn't open on a finished loop.
    func reset() {
        emitted.removeAll()
        scriptStartedAt = nil
        onboardedAt = nil
        dueAt = Date().addingTimeInterval(120)
    }

    // MARK: - SnapAPI

    func onboard(_ body: OnboardRequest) async throws -> OnboardResponse {
        reset()
        onboardedAt = Date()
        return OnboardResponse(
            userId: "mock-user",
            token: "mock-token",
            linkCode: "4821",
            snapContact: .init(telegram: "@snap_bro_bot", imessage: "+15555550123")
        )
    }

    func postWorkouts(_ workouts: [WorkoutDTO]) async throws {
        // A workout arriving early pulls the script forward to the moment Snap sees it.
        guard !workouts.isEmpty else { return }
        advance(to: Self.workoutStep)
    }

    func state() async throws -> SnapState {
        let reached = emitted.count
        return SnapState(
            weeklyGoal: 4,
            workoutsThisWeek: reached > Self.workoutStep ? 3 : 2,
            // Never onboarded through the mock (SNAP_PHASE=live, a reconnect) → already
            // linked, so the brain screen is reachable. Onboarded → the text "arrives"
            // a few seconds after the link screen appears.
            linked: onboardedAt.map { Date().timeIntervalSince($0) >= Self.linkDelay } ?? true,
            commitments: [
                Commitment(
                    id: "c_mock",
                    text: "gym at 7",
                    dueAt: dueAt,
                    graceMin: 20,
                    status: commitmentStatus(reached),
                    // Shaped like a real signature — 88 base58 characters — because the
                    // commitment card builds an explorer URL out of it. The old
                    // placeholder had an ellipsis in it and made a nonsense link.
                    stake: Stake(
                        lamports: 50_000_000,
                        status: stakeStatus(reached),
                        txSig: Self.mockSignature
                    )
                )
            ]
        )
    }

    func trace(since: Int?) async throws -> [TraceEvent] {
        emitDue()
        guard let since else { return emitted }
        return emitted.filter { $0.id > since }
    }

    func timewarp(to date: Date?) async throws {
        guard date != nil else {
            // Reset the clock: put the deadline back in the future.
            dueAt = Date().addingTimeInterval(120)
            return
        }
        // Past the deadline: the countdown goes late and the script jumps to the alarm.
        dueAt = Date().addingTimeInterval(-60 - 20 * 60)
        advance(to: Self.alarmStep)
    }

    func seed() async throws {
        // The mock's history is already the seeded week.
    }

    // MARK: - Script

    /// Releases every step whose turn has come since the script started.
    private func emitDue() {
        let started = scriptStartedAt ?? {
            let now = Date()
            scriptStartedAt = now
            return now
        }()
        let elapsed = Date().timeIntervalSince(started)
        let due = min(Self.script.count, Int(elapsed / Self.stepInterval) + 1)
        append(upTo: due)
    }

    /// Skips ahead so `step` is the last one emitted, and restarts the clock from there.
    private func advance(to step: Int) {
        guard step + 1 > emitted.count else { return }
        append(upTo: step + 1)
        scriptStartedAt = Date().addingTimeInterval(-Double(step) * Self.stepInterval)
    }

    private func append(upTo count: Int) {
        while emitted.count < min(count, Self.script.count) {
            let step = Self.script[emitted.count]
            emitted.append(
                TraceEvent(id: emitted.count + 1, ts: Date(), kind: step.kind, summary: step.summary)
            )
        }
    }

    private func commitmentStatus(_ reached: Int) -> Commitment.Status {
        if reached > Self.workoutStep { return .met }
        if reached > 9 { return .renegotiated }
        return .pending
    }

    private func stakeStatus(_ reached: Int) -> Stake.Status {
        if reached > 12 { return .released }
        if reached > 1 { return .held }
        return .none
    }
}
