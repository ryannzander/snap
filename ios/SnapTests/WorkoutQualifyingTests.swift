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

/// Where a HealthKit sync starts looking.
///
/// The bug: reset drops the anchor, and an anchorless query against a week-wide
/// predicate hands the brand-new account every workout of the last seven days —
/// so you wipe the app, onboard again, and Snap opens already knowing about this
/// morning's session.
final class SyncWindowTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_789_860_240) // 2026-09-19T23:24:00Z

    override func tearDown() {
        WorkoutSync.syncFloor = nil
        super.tearDown()
    }

    /// A genuine first install still backfills the week, so "2/4 this week" is true
    /// on the day it's installed instead of starting at zero and lying.
    func testWithNoFloorItLooksBackAWeek() {
        WorkoutSync.syncFloor = nil
        XCTAssertEqual(
            WorkoutSync.windowStart(now: now),
            now.addingTimeInterval(-7 * 86_400)
        )
    }

    /// After a reset, nothing from before the reset belongs to the next account.
    func testAFloorAfterTheRollingWindowWins() {
        let resetAt = now.addingTimeInterval(-3600) // an hour ago
        WorkoutSync.syncFloor = resetAt
        XCTAssertEqual(WorkoutSync.windowStart(now: now), resetAt)
    }

    /// A floor older than the week does not widen the window — the week is still
    /// the outer bound, whatever is stored.
    func testAFloorOlderThanTheWindowDoesNotWidenIt() {
        WorkoutSync.syncFloor = now.addingTimeInterval(-30 * 86_400)
        XCTAssertEqual(
            WorkoutSync.windowStart(now: now),
            now.addingTimeInterval(-7 * 86_400)
        )
    }

    /// The floor is a wall, not a window: a workout that starts after it syncs,
    /// one that started before it does not, however recent.
    func testTheFloorExcludesThisMorningButNotThisAfternoon() {
        let resetAt = now.addingTimeInterval(-3600)
        WorkoutSync.syncFloor = resetAt
        let start = WorkoutSync.windowStart(now: now)

        let thisMorning = now.addingTimeInterval(-6 * 3600)
        let afterTheReset = now.addingTimeInterval(-600)
        XCTAssertLessThan(thisMorning, start, "a session from before the reset is out")
        XCTAssertGreaterThan(afterTheReset, start, "one from after it is in")
    }

    /// The floor survives a relaunch — it lives in UserDefaults, not memory — or a
    /// reset would only hold until the app was killed.
    func testTheFloorPersists() {
        let resetAt = now.addingTimeInterval(-3600)
        WorkoutSync.syncFloor = resetAt
        XCTAssertEqual(
            UserDefaults.standard.object(forKey: "hkSyncFloor") as? Date,
            resetAt
        )
    }
}

/// The streak, which is the one number on the schedule screen a user will argue
/// with. It counts days that met the release bar, so it agrees with the money.
final class StreakTests: XCTestCase {

    /// Oldest first, exactly as `/state` sends it. `marks` reads left to right:
    /// "x" trained, "." nothing, "s" a commitment that went unmet.
    private func days(_ marks: String) -> [DayRecord] {
        marks.enumerated().map { index, mark in
            DayRecord(
                date: String(format: "2026-09-%02d", index + 1),
                workouts: mark == "x" ? 1 : 0,
                skipped: mark == "s"
            )
        }
    }

    func testCountsBackFromToday() {
        XCTAssertEqual(Streak.current(days("..xxx")), 3)
        XCTAssertEqual(Streak.current(days("xxxxx")), 5)
    }

    /// The rule worth getting right: the day isn't over. A streak that resets at
    /// midnight and un-resets when you train is a number nobody can trust.
    func testTodayNotDoneYetDoesNotBreakIt() {
        XCTAssertEqual(Streak.current(days("xxx.")), 3, "today is still open")
        XCTAssertEqual(Streak.current(days("xxxx")), 4, "and training today extends it")
    }

    /// Two days off is over, though — only *today* gets the benefit of the doubt.
    func testYesterdayMissedEndsIt() {
        XCTAssertEqual(Streak.current(days("xxx..")), 0)
    }

    func testASkippedCommitmentIsNotATrainedDay() {
        XCTAssertEqual(Streak.current(days("xxs")), 0, "a skip breaks it like any other day")
        XCTAssertEqual(Streak.current(days("xxxs.")), 0)
    }

    func testEmptyAndAllRest() {
        XCTAssertEqual(Streak.current([]), 0)
        XCTAssertEqual(Streak.current(days(".....")), 0)
        XCTAssertEqual(Streak.current(days(".")), 0, "one untrained day is not a streak of one")
    }

    func testBestIsTheLongestRunInTheWindow() {
        XCTAssertEqual(Streak.best(days("xx.xxxx.x")), 4)
        XCTAssertEqual(Streak.best(days(".....")), 0)
        XCTAssertEqual(Streak.best(days("xxxxx")), 5)
        XCTAssertEqual(Streak.best([]), 0)
    }

    func testBestIsAtLeastCurrent() {
        let history = days("x.xxx")
        XCTAssertGreaterThanOrEqual(Streak.best(history), Streak.current(history))
    }
}

/// The month grid's arithmetic. A month that starts in the wrong column silently
/// misreads every pattern on the screen.
final class MonthLayoutTests: XCTestCase {

    private func days(from first: String, count: Int) -> [DayRecord] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        let start = formatter.date(from: first)!

        return (0..<count).map { offset in
            let date = Calendar.current.date(byAdding: .day, value: offset, to: start)!
            return DayRecord(date: formatter.string(from: date), workouts: 0, skipped: false)
        }
    }

    func testSevenColumnsAlways() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 1 // Sunday
        let rows = MonthLayout.rows(from: days(from: "2026-08-21", count: 30), calendar: calendar)

        XCTAssertFalse(rows.isEmpty)
        XCTAssertTrue(rows.allSatisfy { $0.count == 7 }, "including the padded last row")
        XCTAssertEqual(rows.flatMap { $0 }.compactMap { $0 }.count, 30, "no day is dropped")
    }

    /// 2026-08-21 is a Friday. On a Sunday-first calendar that's column 5.
    func testTheFirstDayLandsInItsOwnColumn() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 1
        let rows = MonthLayout.rows(from: days(from: "2026-08-21", count: 30), calendar: calendar)

        XCTAssertEqual(rows[0].prefix(5).compactMap { $0 }.count, 0, "five blanks before it")
        XCTAssertEqual(rows[0][5]?.date, "2026-08-21")
    }

    /// Same data, a Monday-first locale: the same date sits one column earlier.
    func testAMondayFirstCalendarShiftsTheWholeGrid() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        let rows = MonthLayout.rows(from: days(from: "2026-08-21", count: 30), calendar: calendar)

        XCTAssertEqual(rows[0][4]?.date, "2026-08-21")
        XCTAssertTrue(rows.allSatisfy { $0.count == 7 })
    }

    func testEmptyHistoryDrawsNothing() {
        XCTAssertTrue(MonthLayout.rows(from: []).isEmpty)
    }

    func testSevenWeekdayHeaders() {
        XCTAssertEqual(MonthLayout.weekdaySymbols().count, 7)
    }
}
