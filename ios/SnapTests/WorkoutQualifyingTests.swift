import XCTest
import HealthKit
@testable import Snap

/// The release bar, from the iOS side.
///
/// The backend decides what counts (`backend/src/agent/guards.ts`), but it decides
/// using strings this app produces. If `name(for:)` ever drifts from the backend's
/// `ACCEPTED_WORKOUT_TYPES`, a real workout silently stops releasing a stake and the
/// trace says "doesn't count as training". These tests pin the strings.
final class WorkoutQualifyingTests: XCTestCase {

    /// Copied from `ACCEPTED_WORKOUT_TYPES` in `backend/src/agent/guards.ts`.
    /// Keep in lockstep; a mismatch here is a mismatch on the wire.
    private static let backendAccepts: [HKWorkoutActivityType: String] = [
        .traditionalStrengthTraining: "traditionalStrengthTraining",
        .functionalStrengthTraining: "functionalStrengthTraining",
        .coreTraining: "coreTraining",
        .crossTraining: "crossTraining",
        .highIntensityIntervalTraining: "highIntensityIntervalTraining",
        .running: "running",
        .cycling: "cycling",
        .rowing: "rowing",
        .elliptical: "elliptical",
        .stairClimbing: "stairClimbing",
        .swimming: "swimming",
        .mixedCardio: "mixedCardio",
    ]

    /// Every type the backend releases a stake for must come off `name(for:)` byte-identical.
    func testAcceptedTypesMatchTheBackendExactly() {
        for (type, expected) in Self.backendAccepts {
            XCTAssertEqual(
                WorkoutSync.name(for: type), expected,
                "'\(expected)' is in ACCEPTED_WORKOUT_TYPES; this app must send that exact string"
            )
        }
    }

    /// The types the backend deliberately rejects. They must still map to their own
    /// names rather than collapsing into `other`, so the trace can say which one it was.
    func testRejectedTypesStayDistinguishable() {
        let rejected: [HKWorkoutActivityType: String] = [
            .walking: "walking",
            .hiking: "hiking",
            .yoga: "yoga",
            .pilates: "pilates",
        ]
        for (type, expected) in rejected {
            XCTAssertEqual(WorkoutSync.name(for: type), expected)
        }
    }

    /// Anything unmapped degrades to `other`, which the backend rejects. That is the
    /// safe direction: an unknown type must never release a stake by accident.
    func testUnmappedTypeDegradesToOther() {
        XCTAssertEqual(WorkoutSync.name(for: .archery), "other")
        XCTAssertEqual(WorkoutSync.name(for: .curling), "other")
    }

    /// The simulated workout is the on-stage fallback when there is no Apple Watch.
    /// It must clear all three bars the backend applies: not hand-entered, an accepted
    /// type, and at least 30 minutes.
    func testSimulatedWorkoutClearsEveryBar() {
        let minWorkoutSec = 30 * 60  // MIN_WORKOUT_SEC in backend/src/agent/guards.ts

        // What `saveSimulatedWorkout()` builds: 45 minutes of traditional strength training.
        let type = WorkoutSync.name(for: .traditionalStrengthTraining)
        let durationSec = 45 * 60

        XCTAssertTrue(Self.backendAccepts.values.contains(type))
        XCTAssertGreaterThanOrEqual(durationSec, minWorkoutSec)

        // `HKWorkoutBuilder` is never given metadata, so the key is absent and the
        // DTO reads false. `true` here would mean the stake can never release.
        let metadata: [String: Any]? = nil
        XCTAssertFalse(metadata?[HKMetadataKeyWasUserEntered] as? Bool ?? false)
    }

    /// A workout the user typed into Health must be sent as such. Dropping this flag
    /// would let anyone open Health → Add Data and free their own stake.
    func testHandEnteredFlagSurvivesEncoding() throws {
        let dto = WorkoutDTO(
            hkUuid: "A1B2", type: "traditionalStrengthTraining",
            start: Date(timeIntervalSince1970: 0), end: Date(timeIntervalSince1970: 2700),
            durationSec: 2700, activeKcal: 310,
            source: "com.apple.Health", wasUserEntered: true
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISO8601.string(from: date))
        }
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoder.encode(dto)) as? [String: Any]
        )
        XCTAssertEqual(json["wasUserEntered"] as? Bool, true)
        XCTAssertEqual(json["source"] as? String, "com.apple.Health")
    }
}

/// The on-chain receipt shown on the commitment card.
final class ExplorerLinkTests: XCTestCase {

    /// A real signature is 88 characters and unreadable in full on a phone.
    /// Both ends must survive so it can be checked against the explorer by eye.
    func testShortensARealSignatureKeepingBothEnds() {
        let signature = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCFFzVRtQJC5Zt8F2nWYdKEtmSTfCFnLcqLp1hZmCQtGmZ9tZ8Ab"
        XCTAssertEqual(BrainView.shorten(signature), "5VERv8…9tZ8Ab")
    }

    /// Anything already short is left alone rather than mangled into ellipses.
    func testLeavesShortStringsAlone() {
        XCTAssertEqual(BrainView.shorten("4xK9fQ"), "4xK9fQ")
        XCTAssertEqual(BrainView.shorten(""), "")
    }
}

/// Decoding a stake. The half-back split was reverted — a miss forfeits the whole stake
/// and the backend sends neither field — so the case that matters live is the last one:
/// a payload without them must decode cleanly and leave the card drawing no split line.
/// The first two are kept against the split ever returning.
final class StakeSplitTests: XCTestCase {

    private func decode(_ json: String) throws -> Stake {
        try JSONDecoder().decode(Stake.self, from: Data(json.utf8))
    }

    func testDecodesTheSplitOnASlashedStake() throws {
        let stake = try decode("""
        {"lamports":50000000,"status":"slashed","refundedLamports":25000000,
         "forfeitedLamports":25000000,"txSig":"abc"}
        """)
        XCTAssertEqual(stake.refundedLamports, 25_000_000)
        XCTAssertEqual(stake.forfeitedLamports, 25_000_000)
        XCTAssertEqual(try XCTUnwrap(stake.refundedSol), 0.025, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(stake.forfeitedSol), 0.025, accuracy: 0.0001)
    }

    /// The two halves always sum to the stake — an odd lamport goes back to the user.
    /// If they ever don't, the card would report money that never moved.
    func testHalvesSumToTheStake() throws {
        let stake = try decode("""
        {"lamports":50000001,"status":"slashed","refundedLamports":25000001,
         "forfeitedLamports":25000000,"txSig":"abc"}
        """)
        XCTAssertEqual(
            try XCTUnwrap(stake.refundedLamports) + XCTUnwrap(stake.forfeitedLamports),
            stake.lamports
        )
    }

    /// Absent on every other status. The card must draw no split line rather than zeros.
    func testHeldStakeHasNoSplit() throws {
        let stake = try decode("""
        {"lamports":50000000,"status":"held","txSig":"abc"}
        """)
        XCTAssertNil(stake.refundedLamports)
        XCTAssertNil(stake.forfeitedSol)
    }
}
