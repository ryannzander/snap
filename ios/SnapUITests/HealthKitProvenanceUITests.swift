import XCTest

/// Proves, on a real HealthKit store, that a workout this app writes does not arrive
/// flagged as hand-entered.
///
/// With no Apple Watch the debug panel's simulated workout is the on-stage path, and the
/// entire demo turns on one bit: the backend refuses to release a stake for a workout with
/// `wasUserEntered: true`. The static argument is that `HKWorkoutBuilder` never sets that
/// metadata — but "the docs imply it" and "we watched it come back false" are different
/// claims, and only one of them is worth betting a demo on.
///
/// Not in the default test run: it needs a simulator and taps a system permission sheet.
/// Run it deliberately:
///
///     xcodebuild test -scheme Snap -only-testing:SnapUITests \
///       -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
final class HealthKitProvenanceUITests: XCTestCase {

    override func setUp() {
        continueAfterFailure = false
    }

    func testSimulatedWorkoutIsNotFlaggedAsHandEntered() {
        let app = XCUIApplication()
        app.launchEnvironment["SNAP_HKDIAG"] = "1"
        app.launch()

        XCTAssertTrue(grantHealthAccess(app), "never got through the Health Access sheet")

        // The diagnostic prints its verdict; the app writes it into the debug panel's
        // error slot too, which is what we can actually assert against from out here.
        let verdict = app.descendants(matching: .any)["hkDiagnostic"]

        // Give the save and read-back time to finish before the harness kills the app;
        // the verdict is also written to Documents/hkdiag.txt for inspection afterwards.
        _ = verdict.waitForExistence(timeout: 40)
        XCTAssertTrue(
            verdict.exists,
            "no HKDIAG verdict surfaced — see Documents/hkdiag.txt in the app container"
        )
        XCTAssertTrue(
            verdict.label.contains("PASS"),
            "simulated workout arrived hand-entered; the stake could never release. Got: \(verdict.label)"
        )
    }

    /// The Health Access sheet is hosted out of process, so it isn't reachable through
    /// `app` alone. Try each host the sheet has lived in across iOS versions rather than
    /// hard-coding one and re-breaking this on the next release.
    private func grantHealthAccess(_ app: XCUIApplication) -> Bool {
        // The sheet is a remote view controller: its controls are vended by the service
        // process, not by the app that presented it. That process exposes the two
        // buttons and the per-category switches, but no "Turn On All" button.
        let sheet = XCUIApplication(bundleIdentifier: "com.apple.HealthPrivacyService")

        // No sheet means HealthKit is already authorized from an earlier run. That is a
        // pass, not a failure: `simctl privacy` has no `health` service, so once granted
        // it cannot be revoked and the sheet never appears again.
        let allow = sheet.buttons["Allow"]
        guard allow.waitForExistence(timeout: 20) else { return true }

        // "Allow" stays disabled until at least one category is switched on. Tapping it
        // while disabled silently grants nothing and still looks like a successful tap,
        // which is how an earlier version of this test passed without authorizing.
        for toggle in sheet.switches.allElementsBoundByIndex where toggle.isHittable {
            if (toggle.value as? String) == "0" { toggle.tap() }
        }

        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if allow.isEnabled, allow.isHittable {
                allow.tap()
                return true
            }
            usleep(300_000)
        }

        print("HKDIAG sheet switches: \(sheet.switches.allElementsBoundByIndex.map { ($0.label, $0.value as? String ?? "?") })")
        return false
    }
}
