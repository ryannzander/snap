import Foundation

/// The seam between the app and the Worker. See docs/API.md.
/// Two implementations: `LiveAPI` (real backend) and `MockAPI` (plays the loop offline).
protocol SnapAPI: Sendable {
    func onboard(_ body: OnboardRequest) async throws -> OnboardResponse
    func postWorkouts(_ workouts: [WorkoutDTO]) async throws
    func state() async throws -> SnapState
    func trace(since: Int?) async throws -> [TraceEvent]
    func timewarp(to date: Date?) async throws
    func seed() async throws
}

/// Carries the status code and body text so the debug panel can show what the server said.
struct APIError: LocalizedError {
    let status: Int
    let body: String

    var errorDescription: String? {
        body.isEmpty ? "HTTP \(status)" : "HTTP \(status) — \(body)"
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
