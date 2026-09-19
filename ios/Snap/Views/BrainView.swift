import SwiftUI

/// The live app: two screens and a bar.
///
/// **today** is the reference's home — a greeting, the week, one dark card for the plan
/// on the line and one white card for the stake — and ends with the last few thoughts
/// from Snap's brain. **brain** is the full trace, the thing judges actually watch.
/// The `+` in the middle of the bar opens the message thread, because a new plan is
/// a text, never a form.
struct BrainView: View {
    @Environment(AppModel.self) private var model
    @State private var tab: Tab = .today
    @State private var showDebug = false

    enum Tab { case today, brain }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(spacing: 0) {
                Group {
                    switch tab {
                    case .today: TodayScreen(openBrain: { tab = .brain }, openDebug: { showDebug = true })
                    case .brain: BrainScreen()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.opacity)
                .id(tab)

                BottomBar(tab: $tab)
            }
        }
        .animation(.snappy(duration: 0.22), value: tab)
        .sheet(isPresented: $showDebug) { DebugPanel() }
    }
}

// MARK: - Bar

/// today · + · brain. The plus is the one filled thing in the bar, and it leaves the app
/// on purpose: Snap lives in the thread, so that's where a plan gets made.
private struct BottomBar: View {
    @Environment(AppModel.self) private var model
    @Binding var tab: BrainView.Tab

    var body: some View {
        HStack {
            item(.today, icon: "house.fill", label: "today")
            Spacer()
            Button {
                ThreadLink.open(contact: model.contact)
            } label: {
                Image(systemName: "plus")
            }
            .buttonStyle(CircleButtonStyle(enabled: ThreadLink.url(contact: model.contact) != nil, size: 58))
            .disabled(ThreadLink.url(contact: model.contact) == nil)
            .accessibilityLabel("text snap a plan")
            Spacer()
            item(.brain, icon: "brain", label: "brain")
        }
        .padding(.horizontal, Theme.Space.xl)
        .padding(.top, Theme.Space.s)
        .padding(.bottom, Theme.Space.xs)
        .background(
            // A soft fade so the scroll content dissolves into the bar instead of
            // being cut by it.
            LinearGradient(colors: [Theme.bg.opacity(0), Theme.bg, Theme.bg],
                           startPoint: .top, endPoint: .bottom)
                .padding(.top, -Theme.Space.m)
                .ignoresSafeArea()
        )
    }

    private func item(_ target: BrainView.Tab, icon: String, label: String) -> some View {
        let selected = tab == target
        return Button {
            tab = target
        } label: {
            VStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 22, weight: selected ? .semibold : .regular))
                Text(label)
                    .font(selected ? Theme.medium(13) : Theme.body(13))
            }
            .foregroundStyle(selected ? Theme.ink : Theme.inkDim)
            .frame(width: 64)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Today

private struct TodayScreen: View {
    @Environment(AppModel.self) private var model
    let openBrain: () -> Void
    let openDebug: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Space.m) {
                header
                WeekStrip()
                PlanCard()
                if let commitment = model.state?.openCommitment ?? model.state?.commitments.last,
                   let stake = commitment.stake, stake.status != .none {
                    StakeCard(stake: stake)
                }
                if model.isHealthAccessUndetermined {
                    healthNotice
                }
                brainPreview
            }
            .padding(.horizontal, Theme.screenPad)
            .padding(.bottom, Theme.Space.m)
        }
        .scrollIndicators(.hidden)
    }

    /// The streak pill, the greeting, and you. Long-press anywhere here for the debug
    /// panel; nothing on screen advertises it.
    private var header: some View {
        let goal = model.state?.weeklyGoal ?? 4
        let done = model.state?.workoutsThisWeek ?? 0

        return HStack {
            HStack(spacing: 5) {
                Image(systemName: "flame.fill")
                    .font(.system(size: 13, weight: .semibold))
                Text("\(done)/\(goal)")
                    .font(Theme.numerals(15))
                    .contentTransition(.numericText())
            }
            .foregroundStyle(done > 0 ? Theme.ink : Theme.inkDim)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(Capsule().stroke(Theme.hairline, lineWidth: 1.5))
            .animation(.snappy, value: done)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(done) of \(goal) workouts this week")

            Spacer()

            Text(Self.greeting(hour: Calendar.current.component(.hour, from: .now)))
                .font(Theme.display(26))
                .foregroundStyle(Theme.ink)

            Spacer()

            Text(model.name.prefix(1).lowercased())
                .font(Theme.medium(15))
                .foregroundStyle(Theme.surface)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Theme.ink))
                .accessibilityLabel(model.name.isEmpty ? "you" : model.name)
        }
        .padding(.top, Theme.Space.xs)
        .contentShape(.rect)
        .onLongPressGesture(minimumDuration: 0.7) { openDebug() }
    }

    static func greeting(hour: Int) -> String {
        switch hour {
        case 5..<12:  "good morning."
        case 12..<17: "good afternoon."
        default:      "good evening."
        }
    }

    /// The one sync state the app can name. HealthKit hides read denial, but "never
    /// asked" is knowable, and it means the closing beat of the demo can't happen.
    private var healthNotice: some View {
        Text("snap can't see your workouts yet. open settings → health → snap.")
            .font(Theme.body(14))
            .foregroundStyle(Theme.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Space.xs)
    }

    /// The last few thoughts, then the way to the rest of them.
    private var brainPreview: some View {
        VStack(spacing: Theme.Space.s) {
            SectionLabel("snap's brain")
                .padding(.top, Theme.Space.s)

            if model.events.isEmpty {
                Text(model.isMock ? "waiting for snap to think…" : "waiting for snap to think… text him a plan.")
                    .font(Theme.body(15))
                    .foregroundStyle(Theme.inkDim)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            } else {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(model.events.suffix(3)) { event in
                        TraceRow(event: event).id(event.id)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button("see everything") { openBrain() }
                .buttonStyle(PillButtonStyle(kind: .pale, wide: false))
                .padding(.top, 4)
        }
    }
}

/// Sunday to Saturday of this week, today in a box — the reference's week bar. It's a
/// calendar, not a scoreboard: the count lives in the streak pill.
private struct WeekStrip: View {
    var body: some View {
        let calendar = Calendar.current
        let today = Date.now
        let start = calendar.dateInterval(of: .weekOfYear, for: today)?.start ?? today

        HStack(spacing: 0) {
            ForEach(0..<7, id: \.self) { offset in
                let day = calendar.date(byAdding: .day, value: offset, to: start) ?? today
                let isToday = calendar.isDate(day, inSameDayAs: today)
                let weekday = calendar.component(.weekday, from: day)
                let symbol = calendar.shortWeekdaySymbols[weekday - 1].prefix(2)

                VStack(spacing: 6) {
                    Text(symbol)
                        .font(isToday ? Theme.medium(15) : Theme.body(15))
                    Text("\(calendar.component(.day, from: day))")
                        .font(isToday ? Theme.numerals(17) : Theme.body(17))
                }
                .foregroundStyle(isToday ? Theme.ink : Theme.inkDim)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(isToday ? Theme.hairline : .clear, lineWidth: 1.5)
                )
                .accessibilityLabel(isToday ? "today, \(day.formatted(.dateTime.weekday(.wide).day()))"
                                            : day.formatted(.dateTime.weekday(.wide).day()))
            }
        }
    }
}

// MARK: - Plan card

/// The dark card: what's on the line, how long is left, and the way into the thread.
/// A settled commitment gets a verdict, not a clock — a countdown that keeps ticking
/// after the thing is decided is just noise.
private struct PlanCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: Theme.Space.m) {
            // Prefer what's open; fall back to the most recent so the finished loop still
            // shows its verdict instead of snapping back to the empty state.
            if let commitment = model.state?.openCommitment ?? model.state?.commitments.last {
                VStack(spacing: 8) {
                    Text(Self.kicker(for: commitment.status))
                        .font(Theme.body(17))
                        .foregroundStyle(Theme.surface.opacity(0.6))
                    Text(commitment.text)
                        .font(Theme.display(26))
                        .foregroundStyle(Theme.surface)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                verdict(for: commitment)
            } else {
                VStack(spacing: 8) {
                    Text("no plan yet")
                        .font(Theme.body(17))
                        .foregroundStyle(Theme.surface.opacity(0.6))
                    Text("what's the move today?")
                        .font(Theme.display(26))
                        .foregroundStyle(Theme.surface)
                        .multilineTextAlignment(.center)
                }
                .padding(.bottom, Theme.Space.m)
            }

            Button("text snap") { ThreadLink.open(contact: model.contact) }
                .buttonStyle(PillButtonStyle(kind: .onDark, enabled: ThreadLink.url(contact: model.contact) != nil, wide: false))
                .disabled(ThreadLink.url(contact: model.contact) == nil)
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.l)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.darkCard))
    }

    static func kicker(for status: Commitment.Status) -> String {
        switch status {
        case .pending:      "today's plan"
        case .renegotiated: "today's plan · rescheduled once"
        case .met:          "today's plan"
        case .missed:       "today's plan"
        case .unknown:      "today's plan"
        }
    }

    @ViewBuilder
    private func verdict(for commitment: Commitment) -> some View {
        switch commitment.status {
        case .met:
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 30, weight: .bold))
                Text("done.")
                    .font(Theme.display(44))
            }
            .foregroundStyle(Theme.surface)
        case .missed:
            Text("missed.")
                .font(Theme.display(44))
                .foregroundStyle(Theme.dangerOnDark)
        case .pending, .renegotiated:
            CountdownView(checkAt: commitment.checkAt)
        case .unknown:
            // A status this build doesn't know. Say nothing rather than guess a clock.
            EmptyView()
        }
    }
}

// MARK: - Stake card

/// The white card: the money, where it is, and the receipt. `slashed` means the whole
/// stake is forfeited — a half-back split was built, deployed and withdrawn on the
/// backend (commit 3f77f7d), so nothing on the wire describes a partial refund.
private struct StakeCard: View {
    @Environment(AppModel.self) private var model
    let stake: Stake

    private static let sol = FloatingPointFormatStyle<Double>.number.precision(.fractionLength(0...3))

    var body: some View {
        VStack(spacing: Theme.Space.s) {
            VStack(spacing: 4) {
                Text("\(stake.sol.formatted(Self.sol)) SOL on the line.")
                    .font(Theme.display(24))
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.center)
                Text(subtitle)
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.inkDim)
            }

            statusPill

            Text(body_)
                .font(Theme.body(17))
                .foregroundStyle(Theme.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if let signature = stake.txSig {
                explorerLink(signature)
            }
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.l)
        .frame(maxWidth: .infinity)
        .snapCard()
    }

    private var subtitle: String {
        switch stake.status {
        case .held:     model.isMock ? "held · mock, no chain" : "held · solana devnet"
        case .released: "released · back in your wallet"
        case .slashed:  "slashed · gone"
        case .none, .unknown: "stake"
        }
    }

    private var body_: String {
        switch stake.status {
        case .held:     "you go, it comes home.\nyou skip, it's gone."
        case .released: "workout landed. snap let go of the stake."
        case .slashed:  "no workout by the deadline. the stake is gone."
        case .none, .unknown: ""
        }
    }

    /// Held is the one moment the app's colour appears: money is out of your hands.
    @ViewBuilder
    private var statusPill: some View {
        let label = Text(stake.status.rawValue)
            .font(Theme.medium(13))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        switch stake.status {
        case .held:     label.foregroundStyle(Theme.surface).background(Capsule().fill(Theme.gradient))
        case .released: label.foregroundStyle(Theme.surface).background(Capsule().fill(Theme.ink))
        case .slashed:  label.foregroundStyle(Theme.surface).background(Capsule().fill(Theme.danger))
        case .none, .unknown: label.foregroundStyle(Theme.inkDim).background(Capsule().fill(Theme.surfaceAlt))
        }
    }

    /// The on-chain receipt. Only drawn when the backend actually got a signature —
    /// with no signature there is no claim to make, so the row simply isn't there.
    /// On the mock it is labelled as such: the mock's signature points at nothing, and a
    /// dead explorer link in front of a Solana judge is worse than no link.
    @ViewBuilder
    private func explorerLink(_ signature: String) -> some View {
        let url = URL(string: "https://explorer.solana.com/tx/\(signature)?cluster=devnet")
        Link(destination: url ?? URL(string: "https://explorer.solana.com")!) {
            HStack(spacing: 8) {
                Image(systemName: "link")
                Text(BrainView.shorten(signature))
                    .font(Theme.mono(13))
                if model.isMock {
                    Text("mock")
                        .foregroundStyle(Theme.inkDim)
                }
            }
        }
        .buttonStyle(PillButtonStyle(kind: .outline, wide: false))
        .accessibilityLabel("View this transaction on Solana Explorer")
    }
}

extension BrainView {
    /// Signatures are 88 characters. Show enough of both ends to check it against
    /// the explorer by eye, which is the only thing anyone does with one on stage.
    nonisolated static func shorten(_ signature: String) -> String {
        guard signature.count > 16 else { return signature }
        return "\(signature.prefix(6))…\(signature.suffix(6))"
    }
}

// MARK: - Countdown

/// Counts down to the moment Snap wakes up, then counts *up* in red once it's passed.
/// Its own view so the `TimelineView` (and its `.now` anchor) is only rebuilt when the
/// deadline itself changes, not every time the rest of the card moves.
private struct CountdownView: View {
    let checkAt: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = checkAt.timeIntervalSince(context.date)
            let late = remaining < 0

            VStack(spacing: 2) {
                Text(Self.clock(abs(remaining)))
                    .font(Theme.numerals(56))
                    .foregroundStyle(late ? Theme.dangerOnDark : Theme.surface)
                Text(late ? "late" : "left")
                    .font(Theme.medium(16))
                    .foregroundStyle(late ? Theme.dangerOnDark : Theme.surface.opacity(0.6))
            }
            .animation(.snappy, value: late)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(late ? "\(Self.clock(abs(remaining))) late" : "\(Self.clock(remaining)) left")
        }
    }

    static func clock(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60)
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, s)
            : String(format: "%d:%02d", m, s)
    }
}

// MARK: - Brain

/// The full trace, and nothing else on the screen to compete with it.
private struct BrainScreen: View {
    var body: some View {
        VStack(spacing: 0) {
            Text("snap's brain.")
                .font(Theme.display(26))
                .foregroundStyle(Theme.ink)
                .frame(maxWidth: .infinity)
                .padding(.top, Theme.Space.xs)
                .padding(.bottom, Theme.Space.xs)
            TraceFeed()
        }
        .padding(.horizontal, Theme.screenPad)
    }
}

/// The feed, isolated so its churn doesn't re-run the header.
/// Anchored to the bottom: it opens on the newest event and stays there as rows arrive,
/// but lets go the moment someone scrolls up to re-read a decision.
private struct TraceFeed: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 9) {
                if model.events.isEmpty {
                    emptyState
                }
                ForEach(model.events) { event in
                    TraceRow(event: event).id(event.id)
                }
            }
            .padding(.vertical, Theme.Space.s)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.hidden)
        .defaultScrollAnchor(.bottom)
        // Rows dissolve into the title instead of being sliced by it.
        .overlay(alignment: .top) {
            LinearGradient(colors: [Theme.bg, Theme.bg.opacity(0)], startPoint: .top, endPoint: .bottom)
                .frame(height: 18)
                .allowsHitTesting(false)
        }
    }

    /// Between beats the screen must never look broken. In voice, dim, and gone the
    /// moment the first event lands.
    private var emptyState: some View {
        Text(model.isMock ? "waiting for snap to think…" : "waiting for snap to think… text him a plan.")
            .font(Theme.body(15))
            .foregroundStyle(Theme.inkDim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 2)
    }
}

// MARK: - Rows

private struct TraceRow: View {
    let event: TraceEvent
    @State private var shown = false

    var body: some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 10)
            .onAppear {
                withAnimation(.snappy(duration: 0.26)) { shown = true }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch event.kind {
        case .messageSent:     bubble(fromSnap: true)
        case .messageReceived: bubble(fromSnap: false)
        case .decision:        decision
        default:               plain
        }
    }

    /// Snap's own messages sit right in ink, yours sit left in grey — this is his head,
    /// not your inbox.
    private func bubble(fromSnap: Bool) -> some View {
        HStack(spacing: 0) {
            if fromSnap { Spacer(minLength: 56) }

            Text(event.summary)
                .font(Theme.body(16))
                .foregroundStyle(fromSnap ? Theme.surface : Theme.ink)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 20)
                        .fill(fromSnap ? Theme.ink : Theme.surfaceAlt)
                )

            if !fromSnap { Spacer(minLength: 56) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(fromSnap ? "snap said: \(event.summary)" : "you said: \(event.summary)")
    }

    /// The moment the agent actually chooses something: a white card, so it stands off
    /// the paper the way the reference's cards do. When the backend sent its reasoning,
    /// it sits under the verdict in small type.
    private var decision: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Theme.tint)
                Text(event.summary)
                    .font(Theme.medium(16))
                Spacer(minLength: 0)
            }
            if let reasoning = event.reasoning {
                Text(reasoning)
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .foregroundStyle(Theme.ink)
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22).fill(Theme.surface))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("decision: \(event.summary)")
    }

    private var plain: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(Self.hms.string(from: event.ts))
                .font(Theme.mono(12))
                .foregroundStyle(Theme.inkDim)
            Image(systemName: glyph)
                .font(.system(size: 12))
                .foregroundStyle(Theme.inkDim)
                .frame(width: 16)
            Text(event.summary)
                .font(Theme.body(15))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 2)
    }

    private var glyph: String {
        switch event.kind {
        case .commitmentCreated: "flag.fill"
        case .alarmFired:        "alarm.fill"
        case .context:           "brain"
        case .workoutDetected:   "figure.strengthtraining.traditional"
        case .stakeHeld:         "lock.fill"
        case .stakeReleased:     "lock.open.fill"
        case .stakeSlashed:      "flame.fill"
        case .stayQuiet:         "zzz"
        default:                 "circle.fill"
        }
    }

    /// Fixed locale and calendar: the trace is a monospaced column, and a device set
    /// to non-Latin digits would break its alignment.
    private static let hms: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}
