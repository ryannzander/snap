import XCTest
@testable import Snap

/// The wire contract with the Worker. These fixtures are shaped exactly like
/// `backend/src/types.ts` — if the backend changes a shape, these fail before the demo does.
final class ContractTests: XCTestCase {

    /// Matches `LiveAPI`'s decoder. Kept in sync deliberately: the strategy is what
    /// we're testing, and `LiveAPI.decoder` is private.
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = ISO8601.date(from: raw) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: raw)
                )
            }
            return date
        }
        return decoder
    }()

    // MARK: - Dates

    /// The backend serializes with `toISOString()`, which always emits fractional
    /// seconds. A plain `ISO8601DateFormatter` rejects those.
    func testParsesTimestampsWithAndWithoutFractionalSeconds() throws {
        let withFraction = ISO8601.date(from: "2026-09-19T23:24:00.000Z")
        let withoutFraction = ISO8601.date(from: "2026-09-19T23:24:00Z")

        XCTAssertNotNil(withFraction)
        XCTAssertNotNil(withoutFraction)
        XCTAssertEqual(withFraction, withoutFraction)
        let fractional = try XCTUnwrap(ISO8601.date(from: "2026-09-19T23:24:00.123Z"))
        XCTAssertEqual(fractional.timeIntervalSince1970, 1_789_860_240.123, accuracy: 0.001)
    }

    func testRejectsGarbageTimestamps() {
        XCTAssertNil(ISO8601.date(from: "not a date"))
        XCTAssertNil(ISO8601.date(from: ""))
    }

    func testEncodesTimestampsTheBackendAccepts() throws {
        let date = try XCTUnwrap(ISO8601.date(from: "2026-09-19T23:24:00Z"))
        XCTAssertEqual(ISO8601.string(from: date), "2026-09-19T23:24:00Z")
    }

    // MARK: - Responses

    func testDecodesOnboardResponse() throws {
        let json = """
        {"userId":"u_1","token":"t_abc","linkCode":"4821",
         "snapContact":{"telegram":"@snap_bro_bot","imessage":"+15555550123"}}
        """
        let response = try decoder.decode(OnboardResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.linkCode, "4821")
        XCTAssertEqual(response.snapContact.telegram, "@snap_bro_bot")
    }

    func testDecodesStateWithHeldStake() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":2,"linked":true,
         "commitments":[{"id":"c_1","text":"gym at 7","dueAt":"2026-09-19T23:00:00.000Z",
         "graceMin":20,"status":"pending",
         "stake":{"lamports":50000000,"status":"held","txSig":"4xK9fQ"}}]}
        """
        let state = try decoder.decode(SnapState.self, from: Data(json.utf8))

        XCTAssertEqual(state.workoutsThisWeek, 2)
        XCTAssertEqual(state.openCommitment?.text, "gym at 7")
        XCTAssertEqual(state.commitments[0].stake?.sol, 0.05)
    }

    /// `txSig` is null until the chain transaction lands.
    func testDecodesSettledStakeWithNullTxSig() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":3,"linked":true,
         "commitments":[{"id":"c_2","text":"gym at 7","dueAt":"2026-09-19T23:00:00.000Z",
         "graceMin":20,"status":"met",
         "stake":{"lamports":50000000,"status":"released","txSig":null}}]}
        """
        let state = try decoder.decode(SnapState.self, from: Data(json.utf8))

        XCTAssertNil(state.commitments[0].stake?.txSig)
        XCTAssertEqual(state.commitments[0].status, .met)
        // A met commitment is not open, so the brain screen shows a verdict not a clock.
        XCTAssertNil(state.openCommitment)
    }

    /// A backend that adds a trace kind must not break the whole feed.
    func testUnknownTraceKindDegradesInsteadOfThrowing() throws {
        let json = """
        {"events":[
         {"id":41,"ts":"2026-09-19T23:24:00.000Z","kind":"alarm_fired","summary":"7:24"},
         {"id":42,"ts":"2026-09-19T23:24:01.500Z","kind":"decision","summary":"firm","data":{"r":"x"}},
         {"id":43,"ts":"2026-09-19T23:24:02.000Z","kind":"brand_new_kind","summary":"???"}]}
        """
        let response = try decoder.decode(TraceResponse.self, from: Data(json.utf8))

        XCTAssertEqual(response.events.count, 3)
        XCTAssertEqual(response.events.map(\.kind), [.alarmFired, .decision, .unknown])
    }

    /// One malformed event (a string id, a missing summary) must not blank the whole
    /// feed — the bad one is dropped and the rest still arrive.
    func testOneMalformedTraceEventIsDroppedNotFatal() throws {
        let json = """
        {"events":[
         {"id":41,"ts":"2026-09-19T23:24:00.000Z","kind":"alarm_fired","summary":"7:24"},
         {"id":"e_42","ts":"2026-09-19T23:24:01.000Z","kind":"decision","summary":"broken id"},
         {"id":43,"ts":"2026-09-19T23:24:02.000Z","kind":"context"},
         {"id":44,"ts":"2026-09-19T23:24:03.000Z","kind":"message_sent","summary":"bro"}]}
        """
        let response = try decoder.decode(TraceResponse.self, from: Data(json.utf8))

        XCTAssertEqual(response.events.map(\.id), [41, 44])
    }

    /// `data.reasoning` is what the decision row shows under its verdict. Anything else
    /// in `data`, or a `data` that isn't an object, is ignored rather than fatal.
    func testDecisionReasoningIsReadAndOddDataIsTolerated() throws {
        let json = """
        {"events":[
         {"id":1,"ts":"2026-09-19T23:24:00Z","kind":"decision","summary":"intervene — firm",
          "data":{"reasoning":"skipped yesterday, money on the line","model":"gpt"}},
         {"id":2,"ts":"2026-09-19T23:24:01Z","kind":"decision","summary":"quiet","data":"nope"},
         {"id":3,"ts":"2026-09-19T23:24:02Z","kind":"decision","summary":"blank","data":{"reasoning":"  "}},
         {"id":4,"ts":"2026-09-19T23:24:03Z","kind":"decision","summary":"stayed quiet — already at the gym",
          "data":{"brain":"openai","tools":["stay_quiet"],"reasoning":"they trained an hour ago"}}]}
        """
        let events = try decoder.decode(TraceResponse.self, from: Data(json.utf8)).events

        XCTAssertEqual(events.count, 4)
        XCTAssertEqual(events[0].reasoning, "skipped yesterday, money on the line")
        XCTAssertNil(events[1].reasoning)
        XCTAssertNil(events[2].reasoning, "whitespace-only reasoning is not worth a line")
        // The backend reports silence as a decision, not a separate kind.
        XCTAssertEqual(events[3].kind, .decision)
        XCTAssertEqual(events[3].reasoning, "they trained an hour ago")
    }

    /// A status the backend adds later must degrade, not take the whole `/state` down —
    /// the countdown, the stake pill and the goal dots all hang off that one call.
    func testUnknownStatusesDegradeInsteadOfThrowing() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":1,"linked":true,
         "commitments":[{"id":"c_9","text":"gym at 7","dueAt":"2026-09-19T23:00:00Z",
         "graceMin":20,"status":"expired",
         "stake":{"lamports":50000000,"status":"refunding","txSig":null}}]}
        """
        let state = try decoder.decode(SnapState.self, from: Data(json.utf8))

        XCTAssertEqual(state.commitments[0].status, .unknown)
        XCTAssertEqual(state.commitments[0].stake?.status, .unknown)
        XCTAssertNil(state.openCommitment, "an unknown status is not an open commitment")
    }

    /// The state poll only republishes on change, which needs value equality that
    /// actually compares the fields.
    func testStateEqualityComparesFields() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":2,"linked":true,
         "commitments":[{"id":"c_1","text":"gym at 7","dueAt":"2026-09-19T23:00:00Z",
         "graceMin":20,"status":"pending","stake":{"lamports":50000000,"status":"held","txSig":"sig"}}]}
        """
        let a = try decoder.decode(SnapState.self, from: Data(json.utf8))
        let b = try decoder.decode(SnapState.self, from: Data(json.utf8))
        let c = try decoder.decode(SnapState.self, from: Data(json.replacingOccurrences(of: "\"held\"", with: "\"released\"").utf8))

        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }

    // MARK: - Derived values

    func testCheckAtIsDueDatePlusGrace() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":0,"linked":true,
         "commitments":[{"id":"c","text":"gym","dueAt":"2026-09-19T23:00:00Z",
         "graceMin":20,"status":"pending","stake":{"lamports":0,"status":"none","txSig":null}}]}
        """
        let state = try decoder.decode(SnapState.self, from: Data(json.utf8))
        let commitment = try XCTUnwrap(state.commitments.first)

        XCTAssertEqual(commitment.checkAt.timeIntervalSince(commitment.dueAt), 20 * 60)
    }

    func testLamportsConvertToSol() throws {
        let json = #"{"lamports":50000000,"status":"held","txSig":null}"#
        let stake = try decoder.decode(Stake.self, from: Data(json.utf8))
        XCTAssertEqual(stake.sol, 0.05, accuracy: 1e-9)
    }

    // MARK: - Wallet

    func testDecodesWallet() throws {
        let json = """
        {"address":"Snap111","cluster":"devnet","balanceLamports":150000000,
         "heldLamports":50000000,"funded":true,
         "entries":[
          {"id":3,"kind":"held","lamports":50000000,"label":"gym at 7","at":"2026-09-19T22:00:00.000Z","txSig":"sig"},
          {"id":2,"kind":"funded","lamports":200000000,"label":"you added money","at":"2026-09-18T10:00:00Z","txSig":null}]}
        """
        let wallet = try decoder.decode(Wallet.self, from: Data(json.utf8))

        XCTAssertEqual(wallet.address, "Snap111")
        XCTAssertEqual(wallet.balanceSol ?? 0, 0.15, accuracy: 1e-9)
        XCTAssertEqual(wallet.heldSol, 0.05, accuracy: 1e-9)
        // What the user thinks of as "my money" is both numbers together, even though
        // half of it is sitting in escrow right now.
        XCTAssertEqual(wallet.totalSol ?? 0, 0.2, accuracy: 1e-9)
        XCTAssertEqual(wallet.entries.map(\.kind), [.held, .funded])
        XCTAssertNil(wallet.entries[1].txSig)
    }

    /// A balance the backend could not read comes back null, and null is not zero: one
    /// means "we can't see it", the other means "it's empty", and under a stake those
    /// are very different sentences to read.
    func testUnreachableChainIsNullBalanceNotZero() throws {
        let json = #"{"address":"Snap111","cluster":"devnet","balanceLamports":null,"heldLamports":0,"funded":true,"entries":[]}"#
        let wallet = try decoder.decode(Wallet.self, from: Data(json.utf8))

        XCTAssertNil(wallet.balanceLamports)
        XCTAssertNil(wallet.balanceSol)
        XCTAssertNil(wallet.totalSol)
    }

    /// Same rule as the trace feed: one bad row must not blank the wallet screen.
    func testOneMalformedWalletEntryIsDropped() throws {
        let json = """
        {"address":"Snap111","cluster":"devnet","balanceLamports":0,"heldLamports":0,"funded":false,
         "entries":[
          {"id":2,"kind":"funded","lamports":10000000,"label":"you added money","at":"2026-09-18T10:00:00Z","txSig":null},
          {"id":"oops","kind":"funded","lamports":1,"label":"bad","at":"2026-09-18T10:00:00Z","txSig":null},
          {"id":1,"kind":"brand_new_kind","lamports":1000,"label":"?","at":"2026-09-18T09:00:00Z","txSig":null}]}
        """
        let wallet = try decoder.decode(Wallet.self, from: Data(json.utf8))

        XCTAssertEqual(wallet.entries.map(\.id), [2, 1])
        XCTAssertEqual(wallet.entries[1].kind, .unknown, "a kind we don't know still shows as a row")
    }

    // MARK: - Reactions

    func testReactionAndWalletTraceKindsDecode() throws {
        let json = """
        {"events":[
         {"id":1,"ts":"2026-09-19T23:24:00Z","kind":"reaction_sent","summary":"😂 on: homework bro"},
         {"id":2,"ts":"2026-09-19T23:24:01Z","kind":"reaction_received","summary":"👍 on: 30 mins then"},
         {"id":3,"ts":"2026-09-19T23:24:02Z","kind":"wallet_funded","summary":"0.1 SOL added to your wallet"}]}
        """
        let events = try decoder.decode(TraceResponse.self, from: Data(json.utf8)).events
        XCTAssertEqual(events.map(\.kind), [.reactionSent, .reactionReceived, .walletFunded])
    }

    func testSplitsAReactionSummaryIntoEmojiAndTarget() {
        let both = BrainView.splitReaction("👍 on: bro lock in")
        XCTAssertEqual(both.0, "👍")
        XCTAssertEqual(both.1, "bro lock in")

        // The backend sends the emoji alone when it doesn't know what was reacted to.
        let alone = BrainView.splitReaction("😂")
        XCTAssertEqual(alone.0, "😂")
        XCTAssertNil(alone.1)

        let empty = BrainView.splitReaction("👍 on: ")
        XCTAssertNil(empty.1, "an empty target is no target, not a blank line")

        XCTAssertEqual(
            BrainView.spokenReaction(emoji: "👍", target: "bro lock in", fromSnap: true),
            "snap reacted 👍 to: bro lock in"
        )
        XCTAssertEqual(
            BrainView.spokenReaction(emoji: "😂", target: nil, fromSnap: false),
            "you reacted 😂"
        )
    }

    // MARK: - Proof

    /// The photo is the verifier, so `proof` is what the plan card reads to
    /// decide whether to ask for a picture or say the money is home.
    func testDecodesAPhotoVerifiedCommitment() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":3,"linked":true,
         "commitments":[{"id":"c_1","text":"gym at 7","dueAt":"2026-09-19T23:00:00.000Z",
         "graceMin":20,"status":"met","verifiedBy":"photo",
         "proof":{"at":"2026-09-19T23:10:00.000Z","description":"a sweaty guy at a squat rack"},
         "stake":{"lamports":50000000,"status":"released","txSig":"4xK9fQ"}}]}
        """
        let commitment = try XCTUnwrap(
            try decoder.decode(SnapState.self, from: Data(json.utf8)).commitments.first
        )

        XCTAssertEqual(commitment.verifiedBy, .photo)
        XCTAssertEqual(commitment.proof?.description, "a sweaty guy at a squat rack")
        XCTAssertFalse(commitment.awaitingProof, "a settled commitment is not waiting on anything")
        XCTAssertEqual(
            BrainView.verifiedLine(for: commitment),
            "pic checked out · a sweaty guy at a squat rack"
        )
    }

    /// An open stake with no photo yet is the state the whole app is built
    /// around: money locked, nothing verified, and a picture being asked for.
    func testAnOpenStakeWithNoPhotoIsAwaitingProof() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":2,"linked":true,
         "commitments":[{"id":"c_1","text":"gym at 7","dueAt":"2026-09-19T23:00:00.000Z",
         "graceMin":20,"status":"pending","proof":null,"verifiedBy":null,
         "stake":{"lamports":50000000,"status":"held","txSig":null}}]}
        """
        let commitment = try XCTUnwrap(
            try decoder.decode(SnapState.self, from: Data(json.utf8)).commitments.first
        )

        XCTAssertNil(commitment.proof)
        XCTAssertTrue(commitment.awaitingProof)
        XCTAssertNil(BrainView.verifiedLine(for: commitment), "nothing has closed it yet")
    }

    /// The watch is the silent fallback. When it pays, the app says so — that
    /// line is the only place a user learns the backstop exists, and it points
    /// straight back at the photo.
    func testWatchFallbackSaysSoAndStillAsksForThePic() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":3,"linked":true,
         "commitments":[{"id":"c_1","text":"gym at 7","dueAt":"2026-09-19T23:00:00.000Z",
         "graceMin":20,"status":"met","verifiedBy":"watch","proof":null,
         "stake":{"lamports":50000000,"status":"released","txSig":"4xK9fQ"}}]}
        """
        let commitment = try XCTUnwrap(
            try decoder.decode(SnapState.self, from: Data(json.utf8)).commitments.first
        )

        XCTAssertEqual(commitment.verifiedBy, .watch)
        let line = try XCTUnwrap(BrainView.verifiedLine(for: commitment))
        XCTAssertTrue(line.contains("watch covered you"))
        XCTAssertTrue(line.contains("pic"), "it still points back at the picture")
    }

    /// A commitment from before this field existed, or from a backend that adds
    /// a third verifier later, must not take the screen down.
    func testMissingOrUnknownVerifierDegrades() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":1,"linked":true,
         "commitments":[
          {"id":"c_1","text":"old","dueAt":"2026-09-18T23:00:00Z","graceMin":20,"status":"met",
           "stake":{"lamports":50000000,"status":"released","txSig":null}},
          {"id":"c_2","text":"new","dueAt":"2026-09-19T23:00:00Z","graceMin":20,"status":"met",
           "verifiedBy":"gps","proof":null,
           "stake":{"lamports":50000000,"status":"released","txSig":null}}]}
        """
        let commitments = try decoder.decode(SnapState.self, from: Data(json.utf8)).commitments

        XCTAssertNil(commitments[0].verifiedBy, "an absent key is absent, not a failure")
        XCTAssertEqual(commitments[1].verifiedBy, .unknown)
        XCTAssertNil(BrainView.verifiedLine(for: commitments[1]), "say nothing rather than guess")
    }

    func testPhotoTraceKindsDecode() throws {
        let json = """
        {"events":[
         {"id":1,"ts":"2026-09-19T23:24:00Z","kind":"photo_accepted","summary":"proof · 0.05 SOL back"},
         {"id":2,"ts":"2026-09-19T23:24:01Z","kind":"photo_rejected","summary":"not proof · that's a screenshot"}]}
        """
        let events = try decoder.decode(TraceResponse.self, from: Data(json.utf8)).events
        XCTAssertEqual(events.map(\.kind), [.photoAccepted, .photoRejected])
    }

    // MARK: - Reschedules

    /// Moving a session is allowed; doing it quietly is not. The log is what
    /// the plan card reads, so it has to survive the wire.
    func testDecodesTheRescheduleLog() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":2,"linked":true,
         "commitments":[{"id":"c_1","text":"gym at 7","dueAt":"2026-09-20T00:30:00.000Z",
         "graceMin":20,"status":"renegotiated","proof":null,"verifiedBy":null,
         "reschedules":[{"at":"2026-09-19T18:00:00Z","from":"2026-09-19T23:00:00Z","to":"2026-09-20T00:30:00Z"}],
         "stake":{"lamports":50000000,"status":"held","txSig":null}}]}
        """
        let commitment = try XCTUnwrap(
            try decoder.decode(SnapState.self, from: Data(json.utf8)).commitments.first
        )

        XCTAssertEqual(commitment.moves.count, 1)
        XCTAssertEqual(commitment.moves[0].from, ISO8601.date(from: "2026-09-19T23:00:00Z"))
        XCTAssertEqual(commitment.moves[0].to, ISO8601.date(from: "2026-09-20T00:30:00Z"))
        // A moved session is still waiting on a picture.
        XCTAssertTrue(commitment.awaitingProof)
    }

    /// A commitment nobody moved, and one from a backend that doesn't send the
    /// key at all, both read as "no moves" rather than failing.
    func testAnAbsentRescheduleLogIsEmptyNotFatal() throws {
        let json = """
        {"weeklyGoal":4,"workoutsThisWeek":2,"linked":true,
         "commitments":[
          {"id":"c_1","text":"a","dueAt":"2026-09-20T00:30:00Z","graceMin":20,"status":"pending",
           "reschedules":[],"stake":{"lamports":50000000,"status":"held","txSig":null}},
          {"id":"c_2","text":"b","dueAt":"2026-09-20T00:30:00Z","graceMin":20,"status":"pending",
           "stake":{"lamports":50000000,"status":"held","txSig":null}}]}
        """
        let commitments = try decoder.decode(SnapState.self, from: Data(json.utf8)).commitments

        XCTAssertEqual(commitments[0].moves, [])
        XCTAssertEqual(commitments[1].moves, [], "an absent key is absent, not a failure")
    }

    func testMoveLineReadsOnTheUsersClock() throws {
        let move = Reschedule(
            at: try XCTUnwrap(ISO8601.date(from: "2026-09-19T18:00:00Z")),
            from: try XCTUnwrap(ISO8601.date(from: "2026-09-19T23:00:00Z")),
            to: try XCTUnwrap(ISO8601.date(from: "2026-09-20T00:30:00Z"))
        )
        let line = BrainView.moveLine(move)

        XCTAssertTrue(line.hasPrefix("moved "))
        XCTAssertTrue(line.contains("→"))
        // Rendered through the device's own locale, so this asserts the shape
        // rather than a fixed string a non-US phone would fail.
        XCTAssertEqual(line.components(separatedBy: "→").count, 2)
    }
}
