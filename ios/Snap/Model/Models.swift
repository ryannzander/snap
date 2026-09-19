import Foundation

// Shapes mirror docs/API.md. Change them there first.

struct OnboardRequest: Encodable {
    let name: String
    let weeklyGoal: Int
    let timezone: String
}

struct OnboardResponse: Codable {
    struct Contact: Codable, Equatable {
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

/// `Equatable` so the poll can skip re-publishing an unchanged state — otherwise every
/// 2-second `/state` round-trip invalidates the whole brain screen for nothing.
struct SnapState: Decodable, Equatable {
    let weeklyGoal: Int
    let workoutsThisWeek: Int
    let linked: Bool
    let commitments: [Commitment]

    var openCommitment: Commitment? {
        commitments.first { $0.status == .pending || $0.status == .renegotiated }
    }
}

struct Commitment: Decodable, Identifiable, Equatable {
    /// A value the backend adds later must not take the whole `/state` decode down with
    /// it — the countdown, the stake pill and the goal dots all hang off this one call.
    enum Status: String, Decodable {
        case pending, met, missed, renegotiated, unknown

        init(from decoder: Decoder) throws {
            self = Status(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    let id: String
    let text: String
    let dueAt: Date
    let graceMin: Int
    let status: Status
    let stake: Stake?

    /// When Snap wakes up to check on this.
    var checkAt: Date { dueAt.addingTimeInterval(Double(graceMin) * 60) }
}

struct Stake: Decodable, Equatable {
    enum Status: String, Decodable {
        case none, held, released, slashed, unknown

        init(from decoder: Decoder) throws {
            self = Status(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    let lamports: Int
    let status: Status
    let txSig: String?

    /// Present only on `slashed`, and they always sum to `lamports`. A miss returns half
    /// and forfeits half, so `slashed` no longer means the whole stake is gone — read
    /// these rather than assuming.
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
        /// The agent looked and chose not to text. DESIGN.md promises this shows too.
        case stayQuiet = "stay_quiet"
        case unknown

        init(from decoder: Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    /// The optional `data` object from API.md. Only `reasoning` is read; anything else
    /// the backend puts in there is ignored, and a `data` that isn't an object is dropped
    /// rather than failing the event.
    struct Detail: Decodable, Equatable {
        let reasoning: String?
    }

    let id: Int
    let ts: Date
    let kind: Kind
    let summary: String
    let data: Detail?

    init(id: Int, ts: Date, kind: Kind, summary: String, data: Detail? = nil) {
        self.id = id
        self.ts = ts
        self.kind = kind
        self.summary = summary
        self.data = data
    }

    private enum CodingKeys: String, CodingKey { case id, ts, kind, summary, data }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        ts = try container.decode(Date.self, forKey: .ts)
        kind = try container.decode(Kind.self, forKey: .kind)
        summary = try container.decode(String.self, forKey: .summary)
        data = try? container.decodeIfPresent(Detail.self, forKey: .data)
    }

    /// The agent's reasoning, when the backend sent it.
    var reasoning: String? {
        guard let reasoning = data?.reasoning?.trimmingCharacters(in: .whitespacesAndNewlines),
              !reasoning.isEmpty else { return nil }
        return reasoning
    }
}

/// One malformed event must not blank the whole feed. Each element decodes on its own;
/// the ones that fail are dropped and the rest still arrive.
struct Lossy<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

struct TraceResponse: Decodable {
    let events: [TraceEvent]

    private enum CodingKeys: String, CodingKey { case events }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        events = try container.decode([Lossy<TraceEvent>].self, forKey: .events).compactMap(\.value)
    }
}
