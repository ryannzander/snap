import SwiftUI

/// What you've actually been doing.
///
/// The today screen answers "what's on the line right now" and forgets everything
/// else the moment it settles. This is the other half: the streak, a month of dots,
/// and every plan you've made with what happened to it — including the ones you
/// moved and the ones that cost you.
///
/// It is deliberately a record, not a planner. There is no "add a session" button
/// here for the same reason the wallet has no "stake now": a commitment Snap did
/// not negotiate is one he can't hold you to, so new plans are made in the thread.
struct ScheduleView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Space.m) {
                StreakCard(days: model.state?.history ?? [],
                           goal: model.state?.weeklyGoal ?? 4,
                           thisWeek: model.state?.workoutsThisWeek ?? 0)
                MonthGrid(days: model.state?.history ?? [])
                plans
            }
            .padding(.horizontal, Theme.screenPad)
            .padding(.top, Theme.Space.xs)
            .padding(.bottom, Theme.Space.m)
        }
        .scrollIndicators(.hidden)
    }

    /// Newest first — the open one, then everything that has already been decided.
    private var plans: some View {
        let commitments = (model.state?.commitments ?? []).reversed().map { $0 }

        return VStack(spacing: Theme.Space.s) {
            SectionLabel("every plan")
                .padding(.top, Theme.Space.xs)

            if commitments.isEmpty {
                Text(model.isMock ? "no plans yet." : "no plans yet. text snap one.")
                    .font(Theme.body(15))
                    .foregroundStyle(Theme.inkDim)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Space.m)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(commitments.enumerated()), id: \.element.id) { index, commitment in
                        if index > 0 { Divider().overlay(Theme.hairline) }
                        PlanRow(commitment: commitment)
                    }
                }
                .snapCard()
            }
        }
    }
}

// MARK: - Streak

private struct StreakCard: View {
    let days: [DayRecord]
    let goal: Int
    let thisWeek: Int

    var body: some View {
        let current = Streak.current(days)
        let best = Streak.best(days)

        VStack(spacing: Theme.Space.s) {
            SectionLabel("streak")

            HStack(spacing: 10) {
                Image(systemName: "flame.fill")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(current > 0 ? AnyShapeStyle(Theme.gradient) : AnyShapeStyle(Theme.hairline))
                Text("\(current)")
                    .font(Theme.numerals(58))
                    .foregroundStyle(Theme.ink)
                    .contentTransition(.numericText())
            }
            .animation(.snappy, value: current)

            Text(Self.caption(current: current, days: days))
                .font(Theme.body(15))
                .foregroundStyle(Theme.inkDim)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 0) {
                stat("\(thisWeek)/\(goal)", "this week")
                Divider().frame(height: 34).overlay(Theme.hairline)
                stat("\(best)", best == 1 ? "best, 1 day" : "best, \(best) days")
            }
            .padding(.top, 4)
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.l)
        .frame(maxWidth: .infinity)
        .snapCard()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(current) day streak. \(thisWeek) of \(goal) this week. best \(best) days."
        )
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(Theme.numerals(20))
                .foregroundStyle(Theme.ink)
            Text(label)
                .font(Theme.body(13))
                .foregroundStyle(Theme.inkDim)
        }
        .frame(maxWidth: .infinity)
    }

    /// The line under the number. It has one job: never make a streak of zero feel
    /// like a punishment, and never let a live one feel safe.
    static func caption(current: Int, days: [DayRecord]) -> String {
        let todayDone = days.last?.trained ?? false
        switch (current, todayDone) {
        case (0, _):  return "no streak yet. today starts one."
        case (1, true): return "day one. again tomorrow."
        case (1, false): return "one day. train today and it's two."
        case (_, true): return "\(current) days in a row."
        default: return "\(current) days in a row. today's still open."
        }
    }
}

// MARK: - The month

/// Thirty days of dots, laid out in weekday columns so a pattern is visible —
/// every-Monday looks like a column, and a bad fortnight looks like a hole.
private struct MonthGrid: View {
    let days: [DayRecord]

    var body: some View {
        VStack(spacing: Theme.Space.s) {
            SectionLabel("the last month")

            HStack(spacing: 6) {
                ForEach(Array(Self.weekdaySymbols().enumerated()), id: \.offset) { _, symbol in
                    Text(symbol)
                        .font(Theme.body(12))
                        .foregroundStyle(Theme.inkDim)
                        .frame(maxWidth: .infinity)
                }
            }

            ForEach(Array(Self.rows(from: days).enumerated()), id: \.offset) { _, row in
                HStack(spacing: 6) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, day in
                        DayDot(day: day)
                            .frame(maxWidth: .infinity)
                    }
                }
            }

            legend
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.l)
        .frame(maxWidth: .infinity)
        .snapCard()
    }

    private var legend: some View {
        HStack(spacing: Theme.Space.s) {
            key(Circle().fill(Theme.ink), "trained")
            key(Circle().stroke(Theme.danger, lineWidth: 2), "skipped")
            key(Circle().stroke(Theme.hairline, lineWidth: 2), "nothing on")
        }
        .padding(.top, 4)
        .accessibilityHidden(true)
    }

    private func key(_ shape: some View, _ label: String) -> some View {
        HStack(spacing: 5) {
            shape.frame(width: 10, height: 10)
            Text(label)
                .font(Theme.body(12))
                .foregroundStyle(Theme.inkDim)
        }
    }

    static func weekdaySymbols() -> [String] { MonthLayout.weekdaySymbols() }
    static func rows(from days: [DayRecord]) -> [[DayRecord?]] { MonthLayout.rows(from: days) }
}

/// The grid's arithmetic, apart from the grid. A month that starts on the wrong
/// column silently misreads every pattern on the screen, and that is worth a test
/// rather than an eyeball.
enum MonthLayout {
    /// Two-letter weekday headers starting on the calendar's own first weekday, so
    /// the columns line up for a week that starts on Monday as well as Sunday.
    static func weekdaySymbols(calendar: Calendar = .current) -> [String] {
        let symbols = calendar.shortWeekdaySymbols
        let first = calendar.firstWeekday - 1
        return (0..<7).map { String(symbols[($0 + first) % 7].prefix(2)) }
    }

    /// Pads the front so the first day lands in its own weekday column, then cuts
    /// into rows of seven. Trailing blanks keep the last row full width.
    static func rows(from days: [DayRecord], calendar: Calendar = .current) -> [[DayRecord?]] {
        guard let firstDate = days.first?.day else { return [] }

        let weekday = calendar.component(.weekday, from: firstDate) - 1
        let leading = (weekday - (calendar.firstWeekday - 1) + 7) % 7

        var cells: [DayRecord?] = Array(repeating: nil, count: leading)
        cells.append(contentsOf: days.map { Optional($0) })
        while cells.count % 7 != 0 { cells.append(nil) }

        return stride(from: 0, to: cells.count, by: 7).map {
            Array(cells[$0..<min($0 + 7, cells.count)])
        }
    }
}

private struct DayDot: View {
    let day: DayRecord?

    var body: some View {
        let isToday = day?.day.map { Calendar.current.isDateInToday($0) } ?? false

        return ZStack {
            if let day {
                if day.trained {
                    Circle().fill(Theme.ink)
                } else if day.skipped {
                    // A commitment that went unmet. Not the same as a day off, and
                    // the only place on this screen the danger colour appears.
                    Circle().stroke(Theme.danger, lineWidth: 2)
                } else {
                    Circle().stroke(Theme.hairline, lineWidth: 2)
                }
            }
        }
        .frame(height: 26)
        .overlay {
            if isToday {
                Circle()
                    .stroke(Theme.ink, lineWidth: 2)
                    .frame(width: 34, height: 34)
            }
        }
        .frame(height: 34)
        .accessibilityLabel(Self.spoken(day, isToday: isToday))
    }

    static func spoken(_ day: DayRecord?, isToday: Bool) -> String {
        guard let day else { return "" }
        let prefix = isToday ? "today, " : "\(day.date), "
        if day.trained { return prefix + (day.workouts == 1 ? "trained" : "\(day.workouts) sessions") }
        if day.skipped { return prefix + "skipped" }
        return prefix + "nothing on"
    }
}

// MARK: - Plans

/// One commitment and what became of it: when it was for, whether it landed, how
/// it was verified, and what the money did.
private struct PlanRow: View {
    let commitment: Commitment

    private static let sol = FloatingPointFormatStyle<Double>.number.precision(.fractionLength(0...3))

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.s) {
            Image(systemName: glyph)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 26)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 3) {
                Text(commitment.text)
                    .font(Theme.medium(15))
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)

                Text(Self.when(commitment))
                    .font(Theme.body(13))
                    .foregroundStyle(Theme.inkDim)

                // Every move, spelled out. Moving a session is allowed; doing it
                // quietly is not, and this is the screen that remembers.
                ForEach(Array(commitment.moves.enumerated()), id: \.offset) { _, move in
                    Text(BrainView.moveLine(move))
                        .font(Theme.body(12))
                        .foregroundStyle(Theme.inkDim)
                }

                if let line = BrainView.verifiedLine(for: commitment) {
                    Text(line)
                        .font(Theme.body(12))
                        .foregroundStyle(Theme.inkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 0)

            if let stake = commitment.stake, stake.status != .none {
                Text(Self.money(stake))
                    .font(Theme.numerals(14))
                    .foregroundStyle(stake.status == .slashed ? Theme.danger : Theme.ink)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.s)
        .accessibilityElement(children: .combine)
    }

    static func when(_ commitment: Commitment) -> String {
        let day = commitment.dueAt.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        let time = commitment.dueAt.formatted(date: .omitted, time: .shortened)
        return "\(day) · \(time)"
    }

    /// Sign, not just size: what came back and what didn't.
    static func money(_ stake: Stake) -> String {
        let amount = stake.sol.formatted(Self.sol)
        switch stake.status {
        case .released: return "+\(amount)"
        case .slashed:  return "−\(amount)"
        case .held:     return amount
        case .none, .unknown: return ""
        }
    }

    private var glyph: String {
        switch commitment.status {
        case .met:     "checkmark.circle.fill"
        case .missed:  "xmark.circle.fill"
        case .pending, .renegotiated: "clock.fill"
        case .unknown: "circle.fill"
        }
    }

    private var tint: Color {
        switch commitment.status {
        case .met:     Theme.ink
        case .missed:  Theme.danger
        default:       Theme.inkDim
        }
    }
}
