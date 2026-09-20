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

    /// How a settled commitment was verified. The photo is what Snap asks for;
    /// the watch is the quiet fallback for a session they trained and forgot to
    /// send a picture of. Which one paid is worth saying out loud — "your watch
    /// covered you" is the line that teaches someone to send the pic next time.
    enum VerifiedBy: String, Decodable {
        case photo, watch, unknown

        init(from decoder: Decoder) throws {
            self = VerifiedBy(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    let id: String
    let text: String
    let dueAt: Date
    let graceMin: Int
    let status: Status
    let stake: Stake?
    /// Every time this session was moved, oldest first. Optional on the wire so
    /// a commitment stored before the log existed still decodes.
    let reschedules: [Reschedule]?
    /// The photo that verified this session, once one has landed. Null before
    /// then — which is the app's cue to ask for one.
    let proof: Proof?
    let verifiedBy: VerifiedBy?

    /// When Snap wakes up to check on this.
    var checkAt: Date { dueAt.addingTimeInterval(Double(graceMin) * 60) }

    var moves: [Reschedule] { reschedules ?? [] }

    /// Still waiting on a picture: open, money locked, nothing verified yet.
    var awaitingProof: Bool {
        (status == .pending || status == .renegotiated) && proof == nil && stake?.status == .held
    }
}

/// One time the session was moved. A list rather than a count because the count
/// only answers "can they move it again", and the list is the thing worth
/// showing someone: this is what you did, and when.
struct Reschedule: Decodable, Equatable {
    /// When they asked.
    let at: Date
    /// The deadline before and after the move.
    let from: Date
    let to: Date
}

/// The photo that released a stake. `description` is what the vision model saw,
/// one sentence, and it is shown to the user — being told what Snap thought he
/// was looking at is the difference between a verdict and a black box.
struct Proof: Decodable, Equatable {
    let at: Date
    let description: String
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
    /// Null until the chain transaction lands (and while the RPC is unreachable —
    /// the backend keeps the loop going and traces the failure).
    let txSig: String?

    /// `slashed` means the whole stake is forfeited. A half-back split was built,
    /// deployed, and then withdrawn (backend commit 3f77f7d); nothing on the wire
    /// describes a partial refund any more.
    var sol: Double { Double(lamports) / 1_000_000_000 }
}

/// `GET /wallet`. Two numbers that must never be added together on screen
/// without saying so: `balanceLamports` is what is in the wallet, `heldLamports`
/// is what has already left it for escrow.
struct Wallet: Decodable, Equatable {
    struct Entry: Decodable, Identifiable, Equatable {
        enum Kind: String, Decodable {
            case funded, held, released, slashed, unknown

            init(from decoder: Decoder) throws {
                self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        let id: Int
        let kind: Kind
        /// Always positive; `kind` says which way the money went.
        let lamports: Int
        let label: String
        let at: Date
        let txSig: String?

        var sol: Double { Double(lamports) / 1_000_000_000 }
    }

    let address: String
    /// Null when the backend could not reach devnet. Not the same as zero — one
    /// means "we can't see it", the other means "it's empty", and under a stake
    /// those read very differently.
    let balanceLamports: Int?
    let heldLamports: Int
    let funded: Bool
    let entries: [Entry]

    var balanceSol: Double? { balanceLamports.map { Double($0) / 1_000_000_000 } }
    var heldSol: Double { Double(heldLamports) / 1_000_000_000 }

    /// Balance plus what is locked — what the user thinks of as "my money",
    /// even though half of it is sitting in escrow right now.
    var totalSol: Double? { balanceSol.map { $0 + heldSol } }

    /// One malformed entry must not blank the wallet screen, same rule as the trace.
    private enum CodingKeys: String, CodingKey {
        case address, balanceLamports, heldLamports, funded, entries
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        address = try container.decode(String.self, forKey: .address)
        balanceLamports = try container.decodeIfPresent(Int.self, forKey: .balanceLamports)
        heldLamports = try container.decodeIfPresent(Int.self, forKey: .heldLamports) ?? 0
        funded = try container.decodeIfPresent(Bool.self, forKey: .funded) ?? false
        entries = (try? container.decode([Lossy<Entry>].self, forKey: .entries))?.compactMap(\.value) ?? []
    }

    init(address: String, balanceLamports: Int?, heldLamports: Int, funded: Bool, entries: [Entry]) {
        self.address = address
        self.balanceLamports = balanceLamports
        self.heldLamports = heldLamports
        self.funded = funded
        self.entries = entries
    }
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
        case reactionSent = "reaction_sent"
        case reactionReceived = "reaction_received"
        case photoAccepted = "photo_accepted"
        case photoRejected = "photo_rejected"
        case walletFunded = "wallet_funded"
        // "Stayed quiet" arrives as a `decision` whose summary says so; it is not a kind.
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
