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
}
