import Foundation

// Shapes mirror docs/API.md. Change them there first.

struct OnboardRequest: Encodable {
    let name: String
    let weeklyGoal: Int
    let timezone: String
}

struct OnboardResponse: Codable {
    struct Contact: Codable {
        let telegram: String?
        let imessage: String?
    }
    let userId: String
    let token: String
    let linkCode: String
    let snapContact: Contact
}

struct WorkoutDTO: Encodable {
    let hkUuid: String
    let type: String
    let start: Date
    let end: Date?
    let durationSec: Int
    let activeKcal: Int?
    /// Bundle id of whatever wrote the sample — a Watch, Strava, Hevy, or Snap itself.
    let source: String
    /// True when a human typed this into the Health app rather than recording it.
    /// The whole product claim is that Snap knows rather than asks, so a hand-typed
    /// workout must not be able to release a stake.
    let wasUserEntered: Bool
}

struct SnapState: Decodable {
    let weeklyGoal: Int
    let workoutsThisWeek: Int
    let linked: Bool
    let commitments: [Commitment]

    var openCommitment: Commitment? {
        commitments.first { $0.status == .pending || $0.status == .renegotiated }
    }
}

struct Commitment: Decodable, Identifiable {
    enum Status: String, Decodable { case pending, met, missed, renegotiated }

    let id: String
    let text: String
    let dueAt: Date
    let graceMin: Int
    let status: Status
    let stake: Stake?

    /// When Snap wakes up to check on this.
    var checkAt: Date { dueAt.addingTimeInterval(Double(graceMin) * 60) }
}

struct Stake: Decodable {
    enum Status: String, Decodable { case none, held, released, slashed }

    let lamports: Int
    let status: Status
    let txSig: String?

    /// Unused as of the revert: a miss forfeits the whole stake again, so the backend
    /// never sends these and `slashed` means exactly what it says. Kept optional and
    /// decoded anyway so a future split needs no model change — and so a backend that
    /// does not send them decodes cleanly today.
    let refundedLamports: Int?
    let forfeitedLamports: Int?

    var sol: Double { Double(lamports) / 1_000_000_000 }
    var refundedSol: Double? { refundedLamports.map { Double($0) / 1_000_000_000 } }
    var forfeitedSol: Double? { forfeitedLamports.map { Double($0) / 1_000_000_000 } }
}

struct TraceEvent: Decodable, Identifiable, Equatable {
    enum Kind: String, Decodable {
        case commitmentCreated = "commitment_created"
        case alarmFired = "alarm_fired"
        case context
        case decision
        case messageSent = "message_sent"
        case messageReceived = "message_received"
        case workoutDetected = "workout_detected"
        case stakeHeld = "stake_held"
        case stakeReleased = "stake_released"
        case stakeSlashed = "stake_slashed"
        case unknown

        init(from decoder: Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    let id: Int
    let ts: Date
    let kind: Kind
    let summary: String
}

struct TraceResponse: Decodable {
    let events: [TraceEvent]
}
