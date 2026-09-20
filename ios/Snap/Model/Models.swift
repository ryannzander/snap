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
    /// The last 30 local days, oldest first. Optional so a backend that predates
    /// the schedule screen still decodes — an absent key is an empty history, not
    /// a failed `/state`, and everything else on the today screen still draws.
    let days: [DayRecord]?

    var openCommitment: Commitment? {
        commitments.first { $0.status == .pending || $0.status == .renegotiated }
    }

    var history: [DayRecord] { days ?? [] }
}

/// One local day. `workouts` counts sessions that met the release bar, so a day
/// with a dot is a day that would have returned your money; `skipped` is a
/// commitment that went unmet, which is a different thing from a day off.
struct DayRecord: Decodable, Equatable, Identifiable {
    let date: String
    let workouts: Int
    let skipped: Bool

    var id: String { date }
    var trained: Bool { workouts > 0 }

    /// The backend sends a local calendar date, already in the user's zone, so it
    /// is parsed as a plain date rather than an instant — reading it as UTC and
    /// re-localising would slide a day either side of midnight.
    var day: Date? { DayRecord.formatter.date(from: date) }

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

/// What the schedule screen puts at the top.
///
/// A day counts when it has a session that met the release bar — the same bar
/// that returns a stake, so the number on this screen and the money agree.
enum Streak {
    /// Days in a row up to today.
    ///
    /// Today not being done yet does **not** break it. The day isn't over, and a
    /// streak that resets every midnight and un-resets when you train would be a
    /// number nobody could trust. It counts back from yesterday in that case, and
    /// today's session extends it the moment it lands.
    ///
    /// Today being *skipped* does break it, though. A commitment that went unmet
    /// is a day already decided — the money has moved — and only an undecided day
    /// gets the benefit of the doubt.
    static func current(_ days: [DayRecord]) -> Int {
        var run = 0
        for day in days.reversed() {
            if day.trained {
                run += 1
            } else if run == 0 && day.id == days.last?.id && !day.skipped {
                // Today, nothing yet. Not a break — the day isn't over.
                continue
            } else {
                break
            }
        }
        return run
    }

    /// The longest run in the window. Capped by it: 30 days of history cannot
    /// prove a 40-day streak, and claiming one would be a lie the app can't see.
    static func best(_ days: [DayRecord]) -> Int {
        var best = 0
        var run = 0
        for day in days {
            run = day.trained ? run + 1 : 0
            best = max(best, run)
        }
        return best
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
    /// The gesture this session's photo has to have in it, picked at random by
    /// the backend the moment the stake locked. Optional on the wire: absent on
    /// a commitment made before challenges existed, and absent means the photo
    /// verifies on its own as before.
    let challenge: String?

    /// What to put on the card, in the backend's own words.
    ///
    /// Deliberately the same strings as `backend/src/agent/challenge.ts` —
    /// Snap says them in the thread and this says them on the card, and a card
    /// asking for something different from the text is worse than a card that
    /// says nothing. An id this build does not know renders nothing rather
    /// than guessing, so the backend can add one without shipping the app.
    var challengeAsk: String? {
        guard let challenge else { return nil }
        switch challenge {
        case "thumb": return "a thumbs up in the pic"
        case "peace": return "a peace sign in the pic"
        case "palm": return "an open hand up in the pic"
        case "rock": return "rock horns 🤘 in the pic"
        case "point": return "point right at the camera in the pic"
        case "both": return "both arms straight up in the pic"
        default: return nil
        }
    }

    /// When Snap wakes up to check on this.
    var checkAt: Date { dueAt.addingTimeInterval(Double(graceMin) * 60) }

    var moves: [Reschedule] { reschedules ?? [] }

    /// Still waiting on a picture: open, money locked, nothing verified yet.
    var awaitingProof: Bool {
        (status == .pending || status == .renegotiated) && proof == nil && stake?.status == .held
    }
}

/// The stage valve, read and written through `POST /debug/demo`.
///
/// The closing beat depends on a vision model judging a photo live, and the
/// likeliest failure is that model hedging at a perfectly good picture —
/// `lenient` rescues exactly that and still refuses screenshots. Every override
/// is marked in the trace, so the brain screen never claims a verdict that
/// wasn't reached.
struct DemoSettings: Decodable, Equatable {
    enum PhotoMode: String, Decodable, CaseIterable, Identifiable {
        /// Ship behaviour: the vision model's word, unassisted.
        case strict
        /// Rescues only "can't tell" — a screenshot is still refused.
        case lenient
        /// Anything that loads counts. For a vision model that is down.
        case always
        case unknown

        var id: String { rawValue }
        /// The three worth offering on stage; `unknown` is a decode fallback.
        static var allCases: [PhotoMode] { [.strict, .lenient, .always] }

        init(from decoder: Decoder) throws {
            self = PhotoMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    let photoMode: PhotoMode
    let allowReplay: Bool
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
