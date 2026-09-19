import SwiftUI

/// The screen that matters: what Snap is thinking, live.
///
/// Three bands — who you are this week, what's on the line right now, and the trace.
/// The trace fills whatever's left, because it's the thing judges actually watch.
struct BrainView: View {
    @Environment(AppModel.self) private var model
    @State private var showDebug = false

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(spacing: Theme.Space.s) {
                header
                commitmentCard
                traceFeed
            }
            .padding(.horizontal, Theme.screenPad)
        }
        .sheet(isPresented: $showDebug) { DebugPanel() }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: Theme.Space.xs) {
            BubbleMark(size: 38)
            Text("snap")
                .font(Theme.display(24))
                .foregroundStyle(Theme.ink)
            Spacer()
            goalDots
        }
        .padding(.top, Theme.Space.xs)
        .contentShape(.rect)
        // Hidden entrance to the debug panel. Nothing on screen advertises it.
        .onLongPressGesture(minimumDuration: 0.7) { showDebug = true }
    }

    private var goalDots: some View {
        let goal = model.state?.weeklyGoal ?? 4
        let done = model.state?.workoutsThisWeek ?? 0
        return HStack(spacing: 6) {
            ForEach(0..<max(goal, 1), id: \.self) { i in
                Circle()
                    .fill(i < done ? Theme.ink : Theme.hairline)
                    .frame(width: 10, height: 10)
            }
        }
        .animation(.snappy, value: done)
    }

    // MARK: - Commitment

    @ViewBuilder
    private var commitmentCard: some View {
        // Prefer what's open; fall back to the most recent so the finished loop still
        // shows its released stake instead of snapping back to the empty state.
        if let commitment = model.state?.openCommitment ?? model.state?.commitments.last {
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                HStack(alignment: .top) {
                    Text(commitment.text)
                        .font(Theme.medium(19))
                        .foregroundStyle(Theme.ink)
                    Spacer(minLength: Theme.Space.xs)
                    if let stake = commitment.stake, stake.status != .none {
                        stakePill(stake)
                    }
                }
                timeline(for: commitment)
                if let stake = commitment.stake, let refunded = stake.refundedSol,
                   let forfeited = stake.forfeitedSol {
                    splitLine(refunded: refunded, forfeited: forfeited)
                }
                if let signature = commitment.stake?.txSig {
                    explorerLink(signature)
                }
            }
            .padding(Theme.Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.surface))
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text("no plan yet.")
                    .font(Theme.display(26))
                    .foregroundStyle(Theme.ink)
                Text("text snap.")
                    .font(Theme.body(16))
                    .foregroundStyle(Theme.inkDim)
            }
            .padding(Theme.Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.surface))
        }
    }

    /// A settled commitment gets a verdict, not a clock — a countdown that keeps ticking
    /// after the thing is decided is just noise.
    @ViewBuilder
    private func timeline(for commitment: Commitment) -> some View {
        switch commitment.status {
        case .met:
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 30, weight: .bold))
                Text("done.")
                    .font(Theme.display(38))
            }
            .foregroundStyle(Theme.ink)
        case .missed:
            Text("missed.")
                .font(Theme.display(38))
                .foregroundStyle(Theme.danger)
        case .pending, .renegotiated:
            countdown(to: commitment.checkAt)
        }
    }

    /// Counts down to the moment Snap wakes up, then counts *up* in red once it's passed.
    private func countdown(to checkAt: Date) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = checkAt.timeIntervalSince(context.date)
            let late = remaining < 0

            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.xs) {
                Text(Self.clock(abs(remaining)))
                    .font(Theme.numerals(52))
                    .monospacedDigit()
                    .foregroundStyle(late ? Theme.danger : Theme.ink)
                Text(late ? "late" : "left")
                    .font(Theme.medium(17))
                    .foregroundStyle(late ? Theme.danger : Theme.inkDim)
            }
            .animation(.snappy, value: late)
        }
    }

    /// What a miss cost, when a miss is ever split again. The backend forfeits the whole
    /// stake today and sends neither field, so this never draws — the `if let` above is
    /// what keeps it from rendering zeros.
    private func splitLine(refunded: Double, forfeited: Double) -> some View {
        let format = FloatingPointFormatStyle<Double>.number.precision(.fractionLength(0...3))
        return Text(
            "\(refunded.formatted(format)) back · \(forfeited.formatted(format)) to charity"
        )
        .font(Theme.mono(11))
        .foregroundStyle(Theme.inkDim)
    }

    /// The on-chain receipt. Only drawn when the backend actually got a signature —
    /// with no signature there is no claim to make, so the row simply isn't there.
    @ViewBuilder
    private func explorerLink(_ signature: String) -> some View {
        let url = URL(string: "https://explorer.solana.com/tx/\(signature)?cluster=devnet")
        Link(destination: url ?? URL(string: "https://explorer.solana.com")!) {
            HStack(spacing: 6) {
                Image(systemName: "link")
                Text(Self.shorten(signature))
                Text("devnet")
                    .foregroundStyle(Theme.inkDim.opacity(0.7))
            }
            .font(Theme.mono(11))
            .foregroundStyle(Theme.inkDim)
        }
        .accessibilityLabel("View this transaction on Solana Explorer")
    }

    /// Signatures are 88 characters. Show enough of both ends to check it against
    /// the explorer by eye, which is the only thing anyone does with one on stage.
    static func shorten(_ signature: String) -> String {
        guard signature.count > 16 else { return signature }
        return "\(signature.prefix(6))…\(signature.suffix(6))"
    }

    private func stakePill(_ stake: Stake) -> some View {
        let fill: Color
        let ink: Color
        switch stake.status {
        case .held:     fill = Theme.accent;   ink = Theme.ink
        case .released: fill = Theme.ink;      ink = Theme.bg
        case .slashed:  fill = Theme.danger;   ink = .white
        case .none:     fill = Theme.hairline; ink = Theme.inkDim
        }

        return Text("\(stake.sol.formatted(.number.precision(.fractionLength(0...3)))) SOL · \(stake.status.rawValue)")
            .font(Theme.mono(12))
            .foregroundStyle(ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Capsule().fill(fill))
            .animation(.snappy, value: stake.status)
    }

    private static func clock(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60)
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, s)
            : String(format: "%d:%02d", m, s)
    }

    // MARK: - Trace

    private var traceFeed: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 9) {
                    ForEach(model.events) { event in
                        TraceRow(event: event).id(event.id)
                    }
                }
                .padding(.vertical, Theme.Space.s)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.hidden)
            // Rows dissolve into the commitment card instead of being sliced by it.
            .mask(
                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .black, location: 0.04),
                        .init(color: .black, location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .onChange(of: model.events.count) {
                guard let last = model.events.last else { return }
                withAnimation(.snappy(duration: 0.3)) {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
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

    /// Snap's own messages sit right, yours sit left — this is his head, not your inbox.
    private func bubble(fromSnap: Bool) -> some View {
        HStack(spacing: 0) {
            if fromSnap { Spacer(minLength: 56) }

            Text(event.summary)
                .font(Theme.body(15))
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 19)
                        .fill(fromSnap ? Theme.accent : Theme.surface)
                )

            if !fromSnap { Spacer(minLength: 56) }
        }
    }

    /// The brightest thing on screen — the moment the agent actually chooses something.
    private var decision: some View {
        HStack(spacing: 10) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 13, weight: .bold))
            Text(event.summary)
                .font(Theme.medium(16))
            Spacer(minLength: 0)
        }
        .foregroundStyle(Theme.ink)
        .padding(.horizontal, Theme.Space.s)
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Theme.accent))
    }

    private var plain: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(Self.hms.string(from: event.ts))
                .font(Theme.mono(11))
                .foregroundStyle(Theme.inkDim)
            Image(systemName: glyph)
                .font(.system(size: 12))
                .foregroundStyle(Theme.inkDim)
                .frame(width: 16)
            Text(event.summary)
                .font(Theme.body(14))
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
        default:                 "circle.fill"
        }
    }

    private static let hms: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}
