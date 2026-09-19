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
