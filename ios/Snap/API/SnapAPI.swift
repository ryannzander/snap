import Foundation

/// The seam between the app and the Worker. See docs/API.md.
/// Two implementations: `LiveAPI` (real backend) and `MockAPI` (plays the loop offline).
protocol SnapAPI: Sendable {
    func onboard(_ body: OnboardRequest) async throws -> OnboardResponse
    func postWorkouts(_ workouts: [WorkoutDTO]) async throws
    func state() async throws -> SnapState
    func wallet() async throws -> Wallet
    /// Adds money. Returns the wallet as it is afterwards, so the screen never
    /// has to guess what the new balance is.
    func topUp(sol: Double) async throws -> Wallet
    func trace(since: Int?) async throws -> [TraceEvent]
    func timewarp(to date: Date?) async throws
    func seed() async throws
}

/// Carries what the server said so the debug panel can show it.
/// Every non-2xx from the Worker is `{ "error": { "code", "message" } }`; anything that
/// isn't (a proxy, a cold start, a crash) falls back to the raw body.
struct APIError: LocalizedError {
    let status: Int
    let code: String?
    let message: String

    init(status: Int, body: String) {
        self.status = status
        if let data = body.data(using: .utf8),
           let envelope = try? JSONDecoder().decode(Envelope.self, from: data) {
            code = envelope.error.code
            message = envelope.error.message
        } else {
            code = nil
            message = body
        }
    }

    private struct Envelope: Decodable {
        struct Inner: Decodable {
            let code: String
            let message: String
        }
        let error: Inner
    }

    /// The token is dead — every subsequent call will fail the same way.
    var isUnauthorized: Bool { status == 401 }

    /// The server answered 2xx but the body didn't decode. Reported with the real
    /// status so a 204 with an empty body isn't mistaken for a malformed 200.
    static func decodeFailure(status: Int, type: Any.Type, underlying: Error) -> APIError {
        APIError(status: status, body: "decode \(type): \(underlying)")
    }

    var errorDescription: String? {
        guard !message.isEmpty else { return "HTTP \(status)" }
        let tag = code.map { " (\($0))" } ?? ""
        return "HTTP \(status)\(tag) — \(message)"
    }
}

/// Workers send `2026-09-19T23:24:00.000Z`; `ISO8601DateFormatter` rejects the fractional
/// seconds unless asked for them, so parse with and without and encode without.
enum ISO8601 {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func date(from string: String) -> Date? {
        fractional.date(from: string) ?? plain.date(from: string)
    }

    static func string(from date: Date) -> String {
        plain.string(from: date)
    }
}
