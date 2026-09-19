import XCTest
import HealthKit
@testable import Snap

/// Every non-2xx from the Worker is `{ "error": { "code", "message" } }`.
final class APIErrorTests: XCTestCase {

    func testParsesTheBackendErrorEnvelope() {
        let error = APIError(
            status: 400,
            body: #"{"error":{"code":"bad_request","message":"weeklyGoal must be 1-21"}}"#
        )
        XCTAssertEqual(error.code, "bad_request")
        XCTAssertEqual(error.message, "weeklyGoal must be 1-21")
        XCTAssertEqual(error.errorDescription, "HTTP 400 (bad_request) — weeklyGoal must be 1-21")
    }

    /// A proxy, a cold start, or a crash won't produce the envelope.
    func testFallsBackToRawBodyForNonEnvelopeResponses() {
        let error = APIError(status: 502, body: "<html>Bad Gateway</html>")
        XCTAssertNil(error.code)
        XCTAssertEqual(error.message, "<html>Bad Gateway</html>")
    }

    func testEmptyBodyStillDescribesTheStatus() {
        XCTAssertEqual(APIError(status: 500, body: "").errorDescription, "HTTP 500")
    }

    /// Drives the latch that stops polling — a dead token fails identically forever.
    func testOnlyA401IsUnauthorized() {
        XCTAssertTrue(APIError(status: 401, body: "").isUnauthorized)
        XCTAssertFalse(APIError(status: 403, body: "").isUnauthorized)
        XCTAssertFalse(APIError(status: 500, body: "").isUnauthorized)
    }

    /// A 2xx whose body didn't decode keeps its real status, so a 204 with an empty
    /// body isn't reported as a malformed 200.
    func testDecodeFailureCarriesTheRealStatus() {
        struct Boom: Error {}
        let error = APIError.decodeFailure(status: 204, type: SnapState.self, underlying: Boom())
        XCTAssertEqual(error.status, 204)
        XCTAssertFalse(error.isUnauthorized)
        XCTAssertTrue(error.message.hasPrefix("decode SnapState"))
    }
}

/// `Config.makeAPI` picks the mock for anything that isn't a usable server URL.
final class ConfigTests: XCTestCase {

    func testOnlyHTTPURLsWithAHostAreServers() {
        XCTAssertNotNil(Config.serverURL(from: "https://snap.snap-backend.workers.dev"))
        XCTAssertNotNil(Config.serverURL(from: "http://localhost:8787"))
        XCTAssertNotNil(Config.serverURL(from: "  https://snap.example.com  "))

        // These used to slip through as "live" and silently run the mock.
        XCTAssertNil(Config.serverURL(from: ""))
        XCTAssertNil(Config.serverURL(from: "snap.snap-backend.workers.dev"))
        XCTAssertNil(Config.serverURL(from: "mailto:someone@example.com"))
        XCTAssertNil(Config.serverURL(from: "https://"))
    }
}

/// `MockAPI` is what the whole UI is built against, so its script has to behave.
final class MockAPITests: XCTestCase {

    func testOnboardReturnsTheDemoLinkCode() async throws {
        let response = try await MockAPI().onboard(
            OnboardRequest(name: "Ryan", weeklyGoal: 4, timezone: "America/Toronto")
        )
        XCTAssertEqual(response.linkCode, "4821")
    }

    func testTraceStartsAtTheTopOfTheScript() async throws {
        let events = try await MockAPI().trace(since: nil)
        XCTAssertEqual(events.first?.kind, .commitmentCreated)
        XCTAssertEqual(events.first?.id, 1)
    }

    /// `since` is exclusive, same as the real backend. The time-warp first so there are
    /// several events on the far side of the cursor — without it the second page is
    /// empty and `allSatisfy` passes vacuously.
    func testTraceSinceIsExclusive() async throws {
        let api = MockAPI()
        let first = try await api.trace(since: nil)
        let firstID = try XCTUnwrap(first.last?.id)

        try await api.timewarp(to: Date())
        let next = try await api.trace(since: firstID)
        XCTAssertFalse(next.isEmpty, "the time-warp should have released more of the script")
        XCTAssertTrue(next.allSatisfy { $0.id > firstID })
        XCTAssertFalse(next.contains { $0.id == firstID }, "since is exclusive")
    }

    /// The debug panel's time-warp has to reach the alarm without waiting out the script.
    func testTimewarpJumpsToTheAlarmAndMakesTheCommitmentLate() async throws {
        let api = MockAPI()
        try await api.timewarp(to: Date())

        let events = try await api.trace(since: nil)
        XCTAssertTrue(events.contains { $0.kind == .alarmFired },
                      "time-warp should reach alarm_fired immediately")

        let state = try await api.state()
        let commitment = try XCTUnwrap(state.commitments.first)
        XCTAssertLessThan(commitment.checkAt, Date(),
                          "after a time-warp the countdown should read late")
    }

    func testResetClockPutsTheDeadlineBackInTheFuture() async throws {
        let api = MockAPI()
        try await api.timewarp(to: Date())
        try await api.timewarp(to: nil)

        let state = try await api.state()
        let commitment = try XCTUnwrap(state.commitments.first)
        XCTAssertGreaterThan(commitment.checkAt, Date())
    }

    /// Posting a workout should pull the script forward to the moment Snap sees it.
    func testPostingAWorkoutAdvancesToWorkoutDetected() async throws {
        let api = MockAPI()
        try await api.postWorkouts([
            WorkoutDTO(hkUuid: "u", type: "traditionalStrengthTraining",
                       start: Date(), end: Date(), durationSec: 2700, activeKcal: 300,
                       source: "com.apple.health", wasUserEntered: false)
        ])

        let events = try await api.trace(since: nil)
        XCTAssertTrue(events.contains { $0.kind == .workoutDetected })
    }

    func testStakeAndWeeklyCountFollowTheScript() async throws {
        let api = MockAPI()

        let before = try await api.state()
        XCTAssertEqual(before.workoutsThisWeek, 2)

        try await api.postWorkouts([
            WorkoutDTO(hkUuid: "u", type: "running",
                       start: Date(), end: Date(), durationSec: 1800, activeKcal: nil,
                       source: "com.strava.stravaride", wasUserEntered: false)
        ])

        let after = try await api.state()
        XCTAssertEqual(after.workoutsThisWeek, 3, "a detected workout should count")
        XCTAssertEqual(after.commitments.first?.status, .met)
    }

    /// The link screen must actually be seen on the offline path: right after onboarding
    /// the mock is not linked yet, and it flips on its own a few seconds later.
    func testLinkedFlipsAfterOnboardingNotAtLaunch() async throws {
        let api = MockAPI()
        // Never onboarded through the mock (SNAP_PHASE=live): straight to the brain screen.
        let cold = try await api.state()
        XCTAssertTrue(cold.linked)

        _ = try await api.onboard(OnboardRequest(name: "Ryan", weeklyGoal: 4, timezone: "UTC"))
        let justOnboarded = try await api.state()
        XCTAssertFalse(justOnboarded.linked, "the link screen should have a moment on screen")
    }

    /// The mock is a process-wide singleton. A second run-through of the demo must start
    /// from the top of the script, not from a finished loop.
    func testResetRewindsTheScript() async throws {
        let api = MockAPI()
        try await api.timewarp(to: Date())
        let warmed = try await api.trace(since: nil)
        XCTAssertTrue(warmed.contains { $0.kind == .alarmFired })

        await api.reset()

        let events = try await api.trace(since: nil)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.kind, .commitmentCreated)
        let state = try await api.state()
        XCTAssertGreaterThan(try XCTUnwrap(state.commitments.first).checkAt, Date())
        XCTAssertEqual(state.commitments.first?.status, .pending)
    }
}

/// The backend matches on the `HKWorkoutActivityType` case name.
final class WorkoutTypeNameTests: XCTestCase {

    func testMapsTheTypesTheDemoUses() {
        XCTAssertEqual(WorkoutSync.name(for: .traditionalStrengthTraining),
                       "traditionalStrengthTraining")
        XCTAssertEqual(WorkoutSync.name(for: .running), "running")
        XCTAssertEqual(WorkoutSync.name(for: .highIntensityIntervalTraining),
                       "highIntensityIntervalTraining")
    }

    func testUnmappedTypesFallBackToOther() {
        XCTAssertEqual(WorkoutSync.name(for: .archery), "other")
    }
}
