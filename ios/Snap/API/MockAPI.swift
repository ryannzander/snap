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
        Step(.context,           "no pic today · skipped yesterday · 2/4 this week · 0.05 SOL staked"),
        Step(.decision,          "intervene — firm"),
        Step(.messageSent,       "bro"),
        Step(.messageSent,       "7:24 and no pic 😭"),
        Step(.messageSent,       "you said no excuses today"),
        Step(.messageReceived,   "homework bro"),
        Step(.reactionSent,      "😂 on: homework bro"),
        // The door shut an hour before the session, and they already used their
        // one move earlier in the day. Both limits, refused out loud.
        Step(.decision,          "refused reschedule_commitment — that session is already due"),
        Step(.messageSent,       "nah. you moved it once already. go now"),
        Step(.reactionReceived,  "👍 on: nah. you moved it once already. go now"),
        // The first pic is the one everybody tries. It does not pass.
        Step(.messageReceived,   "📷 sent a photo"),
        Step(.context,           "looked at the photo · a screenshot of a workout app"),
        Step(.photoRejected,     "not proof · that's a screenshot"),
        Step(.messageSent,       "nice try 💀 you in the shot, on the floor"),
        Step(.messageReceived,   "📷 sent a photo"),
        Step(.context,           "looked at the photo · a sweaty guy at a squat rack, mid-set"),
        Step(.photoAccepted,     "proof · 0.05 SOL back on \"gym at 7\""),
        Step(.stakeReleased,     "0.05 SOL back in your wallet"),
        Step(.messageSent,       "that's my guy"),
    ]

    private static let stepInterval: TimeInterval = 1.2
    // Indices into `script`. Named rather than inlined because inserting a step
    // silently moved the stake's release two beats away from where the state
    // said it happened.
    private static let alarmStep = 2
    /// The pic that passes — the mock's stand-in for the workout beat, and what
    /// `postWorkouts` jumps to when a real HealthKit sample arrives early.
    private static let proofStep = 19
    private static let releaseStep = 20

    /// The link screen "receives the text" this long after onboarding. Anchored to the
    /// onboard call, not process launch: the mock is a singleton built at launch, and
    /// clicking through onboarding takes longer than any delay measured from there.
    private static let linkDelay: TimeInterval = 6

    /// The mock's wallet. Money moves here the same way it does on the server —
    /// a top-up adds to it, and the staked 0.05 is shown as held — so the wallet
    /// screen can be built and demoed with no backend at all.
    private var balanceLamports = 150_000_000
    private var walletEntries: [Wallet.Entry] = [
        Wallet.Entry(id: 2, kind: .held, lamports: 50_000_000, label: "gym at 7",
                     at: Date().addingTimeInterval(-600), txSig: MockAPI.mockSignature),
        Wallet.Entry(id: 1, kind: .funded, lamports: 200_000_000, label: "starting balance from snap",
                     at: Date().addingTimeInterval(-86_400), txSig: MockAPI.mockSignature),
    ]

    private var demo = DemoSettings(photoMode: .strict, allowReplay: false)

    /// Set when a HealthKit workout, rather than the scripted photo, closed the
    /// loop. See `postWorkouts`.
    private var releasedByWatch = false

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
        releasedByWatch = false
        balanceLamports = 150_000_000
        walletEntries = [
            Wallet.Entry(id: 2, kind: .held, lamports: 50_000_000, label: "gym at 7",
                         at: Date().addingTimeInterval(-600), txSig: MockAPI.mockSignature),
            Wallet.Entry(id: 1, kind: .funded, lamports: 200_000_000, label: "starting balance from snap",
                         at: Date().addingTimeInterval(-86_400), txSig: MockAPI.mockSignature),
        ]
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
        // A real workout is the watch covering them, not the pic. It pulls the
        // script forward to the same closing beat, but the commitment then says
        // it was the watch that paid — which is the only way to see that copy
        // offline, since the mock has no way to receive an actual photo.
        guard !workouts.isEmpty else { return }
        releasedByWatch = true
        advance(to: Self.proofStep)
    }

    /// A month of history for the schedule screen: a live streak running into
    /// today, one skipped day, and a fallow patch before it — enough shape that
    /// the grid and both streak numbers mean something offline.
    private func history(trainedToday: Bool) -> [DayRecord] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"

        // Index 29 is today, 0 is 29 days ago.
        let trainedAgo: Set<Int> = [1, 2, 4, 6, 8, 9, 11, 15, 16, 18, 22, 25]
        let skippedAgo: Set<Int> = [3, 13]

        return (0..<30).reversed().compactMap { ago in
            guard let date = Calendar.current.date(byAdding: .day, value: -ago, to: Date()) else {
                return nil
            }
            let trained = ago == 0 ? trainedToday : trainedAgo.contains(ago)
            return DayRecord(
                date: formatter.string(from: date),
                workouts: trained ? 1 : 0,
                skipped: skippedAgo.contains(ago)
            )
        }
    }

    func state() async throws -> SnapState {
        let reached = emitted.count
        return SnapState(
            weeklyGoal: 4,
            workoutsThisWeek: reached > Self.proofStep ? 3 : 2,
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
                    ),
                    // One legal move, made early in the day, so the plan card has a
                    // log line to show. The late one the script refuses is not in
                    // here — a refused move is not a move.
                    reschedules: [
                        Reschedule(
                            at: dueAt.addingTimeInterval(-3 * 3600),
                            from: dueAt.addingTimeInterval(-3600),
                            to: dueAt
                        )
                    ],
                    proof: reached > Self.proofStep && !releasedByWatch
                        ? Proof(at: Date(), description: "a sweaty guy at a squat rack, mid-set")
                        : nil,
                    verifiedBy: reached > Self.proofStep ? (releasedByWatch ? .watch : .photo) : nil
                )
            ],
            // Today's dot fills in the moment the scripted pic lands, so the streak
            // ticks up on screen during the demo rather than being a static number.
            days: history(trainedToday: reached > Self.proofStep)
        )
    }

    func wallet() async throws -> Wallet {
        let released = emitted.count > Self.releaseStep
        return Wallet(
            address: "SnapMockWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx",
            // Once the script releases the stake it is back in the balance and
            // no longer held, exactly as it would be for real.
            balanceLamports: released ? balanceLamports + 50_000_000 : balanceLamports,
            heldLamports: released ? 0 : 50_000_000,
            funded: true,
            // Not a literal: topUp mints (highest + 1), so a hard-coded 3 collides
            // with the first added-money row and the wallet history ForEach ends
            // up with two entries sharing an id.
            entries: released
                ? [Wallet.Entry(id: (walletEntries.first?.id ?? 0) + 1, kind: .released,
                                lamports: 50_000_000, label: "gym at 7",
                                at: Date(), txSig: MockAPI.mockSignature)] + walletEntries
                : walletEntries
        )
    }

    func topUp(sol: Double) async throws -> Wallet {
        let lamports = Int((sol * 1_000_000_000).rounded())
        balanceLamports += lamports
        walletEntries.insert(
            Wallet.Entry(id: (walletEntries.first?.id ?? 0) + 1, kind: .funded, lamports: lamports,
                         label: "you added money", at: Date(), txSig: MockAPI.mockSignature),
            at: 0
        )
        return try await wallet()
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

    /// No server to stand down, but the mock is a process-wide singleton — without
    /// this a second run-through opens on a finished loop.
    func forget() async throws {
        reset()
    }

    func demoSettings(
        photoMode: DemoSettings.PhotoMode?,
        allowReplay: Bool?
    ) async throws -> DemoSettings {
        demo = DemoSettings(
            photoMode: photoMode ?? demo.photoMode,
            allowReplay: allowReplay ?? demo.allowReplay
        )
        return demo
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
        if reached > Self.proofStep { return .met }
        // `renegotiated` from the start: the move in `reschedules` happened
        // hours before the script opens, which is the only time it is allowed.
        return .renegotiated
    }

    private func stakeStatus(_ reached: Int) -> Stake.Status {
        if reached > Self.releaseStep { return .released }
        if reached > 1 { return .held }
        return .none
    }
}
