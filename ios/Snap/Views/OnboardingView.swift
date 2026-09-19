import SwiftUI

/// Five pages, one idea each, then `POST /onboard`.
///
/// The order is deliberate: we ask for the cheap things first (name, goal), explain the
/// stake *before* anyone is surprised by it, and only then put up the HealthKit sheet —
/// with the reason on screen behind it.
///
/// Every page is the same shape as the reference's check-in: chrome across the top,
/// an illustration, the question in grey, the explanation, and the answer as a big
/// statement at the bottom — with the next arrow under the thumb.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model

    private enum Page: Int, CaseIterable {
        case hello, name, goal, deal, health

        /// `SNAP_PAGE=goal` opens straight onto a page, so a screen can be iterated on
        /// without clicking through the flow on every rebuild.
        static var initial: Page {
            #if DEBUG
            if let raw = ProcessInfo.processInfo.environment["SNAP_PAGE"],
               let match = allCases.first(where: { "\($0)" == raw }) {
                return match
            }
            #endif
            return .hello
        }
    }

    @State private var page: Page = .initial
    @State private var name = ""
    @State private var goal = 4
    @State private var submitting = false
    @State private var attemptFailed = false
    @State private var showDebug = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(spacing: 0) {
                header

                // The identity (and so the transition) is on the page, but the frame is on
                // the container: with both on the same view, the outgoing and incoming
                // pages briefly share the VStack's height and every page change squashes.
                ZStack {
                    Group {
                        switch page {
                        case .hello:  HelloPage()
                        case .name:   NamePage(name: $name, focused: $nameFocused, submit: advance)
                        case .goal:   GoalPage(goal: $goal)
                        case .deal:   DealPage()
                        case .health: HealthPage()
                        }
                    }
                    .transition(.asymmetric(
                        insertion: .offset(x: 40).combined(with: .opacity),
                        removal: .offset(x: -40).combined(with: .opacity)
                    ))
                    .id(page)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                footer
            }
            .padding(.horizontal, Theme.screenPad)
        }
        .animation(.snappy(duration: 0.28), value: page)
        .sheet(isPresented: $showDebug) { DebugPanel() }
    }

    // MARK: - Chrome

    /// Back on the left, the dashes in the middle, a cross on the right that starts the
    /// flow over. The hello page shows none of it — it's a cover, not a step.
    private var header: some View {
        HStack {
            Button { back() } label: { Image(systemName: "chevron.left") }
                .buttonStyle(ChromeButtonStyle())
                .accessibilityLabel("back")

            Spacer()
            ProgressDashes(count: Page.allCases.count - 1, index: page.rawValue - 1)
                .frame(height: 44)
                .contentShape(.rect)
                // The debug panel is otherwise unreachable before a token exists, and the
                // server URL is the one thing that can fix a failed onboard.
                .onLongPressGesture(minimumDuration: 0.7) { showDebug = true }
                .accessibilityLabel("step \(page.rawValue) of \(Page.allCases.count - 1)")
            Spacer()

            Button { startOver() } label: { Image(systemName: "xmark") }
                .buttonStyle(ChromeButtonStyle())
                .accessibilityLabel("start over")
        }
        .padding(.top, Theme.Space.xs)
        .opacity(page == .hello ? 0 : 1)
        .disabled(page == .hello)
    }

    private var footer: some View {
        Group {
            switch page {
            case .hello:
                Button("let's go") { advance() }
                    .buttonStyle(PillButtonStyle())
            case .health:
                VStack(spacing: Theme.Space.s) {
                    // No error dialog, ever — but a tap that does nothing is worse. One dim
                    // line in voice, only after a failed attempt on this page.
                    if attemptFailed, !submitting {
                        Text("can't reach snap. hold the dashes up top to check the server.")
                            .font(Theme.body(14))
                            .foregroundStyle(Theme.danger)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel("error: \(model.lastError ?? "onboarding failed")")
                    }

                    Button(submitting ? "one sec…" : "connect & finish") {
                        Task { await finish() }
                    }
                    .buttonStyle(PillButtonStyle(enabled: !submitting))
                    .disabled(submitting)

                    Button("skip for now") { Task { await finish(health: false) } }
                        .font(Theme.medium(15))
                        .foregroundStyle(Theme.inkDim)
                        .disabled(submitting)
                }
            default:
                HStack {
                    Spacer()
                    Button { advance() } label: { Image(systemName: "chevron.right") }
                        .buttonStyle(CircleButtonStyle(enabled: canAdvance))
                        .disabled(!canAdvance)
                        .accessibilityLabel("next")
                }
            }
        }
        .padding(.bottom, Theme.Space.m)
    }

    // MARK: - Flow

    private var canAdvance: Bool {
        switch page {
        case .name: !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default: true
        }
    }

    private func advance() {
        nameFocused = false
        guard let next = Page(rawValue: page.rawValue + 1) else { return }
        page = next
    }

    private func back() {
        nameFocused = false
        guard let previous = Page(rawValue: page.rawValue - 1) else { return }
        page = previous
    }

    /// The cross. Back to the cover with the answers cleared, so the flow can be shown
    /// again from the top without killing the app.
    private func startOver() {
        nameFocused = false
        name = ""
        goal = 4
        attemptFailed = false
        page = .hello
    }

    /// Permission first so the system sheet appears over the page explaining why.
    /// A denial still continues — the app just won't sync.
    ///
    /// `submitting` is set here, not in the model, because the HealthKit sheet is up
    /// before `onboard` runs and a second tap during it would create a second user.
    private func finish(health: Bool = true) async {
        guard !submitting else { return }
        submitting = true
        defer { submitting = false }
        if health { await model.requestHealthAuthorization() }
        await model.onboard(name: name, goal: goal)
        // Still here means the request didn't succeed; the model kept the reason.
        attemptFailed = model.phase == .onboarding
    }
}

// MARK: - Pages

/// The cover: the line up top, Snap himself filling the bottom of the screen.
private struct HelloPage: View {
    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Statement("meet snap.\nyour gym bro\nin your texts.")
            Spacer()
            SnapMark(size: 300)
                .offset(x: -30)
                .accessibilityHidden(true)
            Spacer(minLength: Theme.Space.m)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct NamePage: View {
    @Binding var name: String
    @FocusState.Binding var focused: Bool
    let submit: () -> Void

    var body: some View {
        VStack(spacing: Theme.Space.m) {
            Spacer()
            SnapMark(size: 120)
            Question("what should\nsnap call you?")
            Explanation("first name is plenty. it's what he'll text you as.")

            Spacer()

            VStack(spacing: Theme.Space.xs) {
                TextField("", text: $name, prompt: Text("your name").foregroundStyle(Theme.inkDim))
                    .font(Theme.display(38))
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.center)
                    .textContentType(.givenName)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($focused)
                    .accessibilityLabel("your name")
                    // "done" on the keyboard means the same as the arrow.
                    .onSubmit {
                        if !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { submit() }
                    }

                Rectangle()
                    .fill(focused ? Theme.ink : Theme.hairline)
                    .frame(width: 180, height: 2)
                    .animation(.snappy, value: focused)
            }

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity)
        // Focus after the page transition has settled; focusing mid-transition is the
        // classic way for the keyboard to silently not appear.
        .task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            focused = true
        }
    }
}

/// The answer is a sentence that rewrites itself as the slider moves — the reference's
/// "Last night / I slept quite well." beat, with the number said out loud.
private struct GoalPage: View {
    @Binding var goal: Int

    var body: some View {
        VStack(spacing: Theme.Space.m) {
            Spacer()
            DumbbellMark()
                .frame(width: 180, height: 110)
            Question("how many days\na week?")
            Explanation("this is the number snap holds you to. miss it and he has something to say. after a week you'll see how you did on the today screen.")

            Spacer()

            VStack(spacing: 4) {
                Text("every week")
                    .font(Theme.body(30))
                    .foregroundStyle(Theme.inkDim)
                Text(Self.statement(for: goal))
                    .font(Theme.display(34))
                    .foregroundStyle(Theme.ink)
                    .contentTransition(.numericText())
                    .animation(.snappy(duration: 0.2), value: goal)
            }
            .accessibilityElement(children: .combine)

            SnapSlider(value: $goal, range: 1...7, minLabel: "once", maxLabel: "every day")
                .padding(.horizontal, Theme.Space.xs)
                .accessibilityLabel("days a week")

            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    static func statement(for goal: Int) -> String {
        switch goal {
        case 1: "i'll train once."
        case 7: "i'll train every day."
        default: "i'll train \(goal) days."
        }
    }
}

/// The stake gets its own beat, laid out like a plan page: the headline, the one line
/// in colour, then a card of what you get — with the row that costs money marked.
private struct DealPage: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            Spacer()

            VStack(alignment: .leading, spacing: Theme.Space.s) {
                Text("put money\non it.")
                    .font(Theme.display(40))
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)

                // Segment styles on concatenated text: the number takes the gradient,
                // the words around it stay grey.
                (Text("with ").foregroundStyle(Theme.inkDim)
                    + Text("0.05 SOL").foregroundStyle(Theme.gradient).fontWeight(.bold)
                    + Text(" on the line, every plan.").foregroundStyle(Theme.inkDim))
                    .font(Theme.body(20))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(spacing: 0) {
                DealRow(icon: "message.fill", title: "text a plan",
                        text: "\u{201C}gym at 7, $5 on it\u{201D} is enough. snap turns it into a commitment.")
                Divider().overlay(Theme.hairline)
                DealRow(icon: "heart.fill", title: "he checks, not asks",
                        text: "your watch tells him whether you went. no photos, no honor system.")
                Divider().overlay(Theme.hairline)
                DealRow(icon: "lock.fill", title: "show up, get it back",
                        text: "go and the stake comes home. skip and it's gone.",
                        pill: "SOL")
                Divider().overlay(Theme.hairline)
                DealRow(icon: "wallet.bifold.fill", title: "it comes from your wallet",
                        text: "there's one in the app. top it up, and snap stakes out of it.")
            }
            .snapCard()

            Text("held on solana devnet · returned the moment your workout lands")
                .font(Theme.body(14))
                .foregroundStyle(Theme.inkDim)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)

            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

private struct DealRow: View {
    let icon: String
    let title: String
    let text: String
    var pill: String?

    var body: some View {
        HStack(alignment: .center, spacing: Theme.Space.s) {
            Image(systemName: icon)
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .frame(width: 44)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(Theme.medium(17))
                    .foregroundStyle(Theme.ink)
                Text(text)
                    .font(Theme.body(15))
                    .foregroundStyle(Theme.inkDim)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)

            if let pill {
                Text(pill)
                    .font(Theme.medium(13))
                    .foregroundStyle(Theme.surface)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Theme.tint))
            }
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.s + 4)
    }
}

private struct HealthPage: View {
    var body: some View {
        VStack(spacing: Theme.Space.m) {
            Spacer()
            Image(systemName: "heart.text.square.fill")
                .font(.system(size: 88))
                .foregroundStyle(Theme.ink)
            Question("i need to see\nyour workouts.")
            Explanation("that's the whole trick. snap reads HealthKit, so he never has to ask if you went.\n\napple watch, strava, hevy, nike run club, whoop — anything that logs a workout counts. you only need one of them.\n\nnothing leaves your phone except the workout itself.")
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Bits

/// The big bold line, centred.
private struct Statement: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Theme.display(38))
            .foregroundStyle(Theme.ink)
            .multilineTextAlignment(.center)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The question, in grey — the answer is what gets the ink.
private struct Question: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Theme.medium(22))
            .foregroundStyle(Theme.inkDim)
            .multilineTextAlignment(.center)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct Explanation: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Theme.body(16))
            .foregroundStyle(Theme.inkDim)
            .multilineTextAlignment(.center)
            .lineSpacing(4)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Theme.Space.xs)
    }
}

/// The goal page's illustration: a dumbbell in the same flat ink as the mark.
private struct DumbbellMark: View {
    var body: some View {
        Canvas { context, size in
            let s = size.width / 180
            let midY = size.height / 2
            func plate(x: CGFloat, w: CGFloat, h: CGFloat) -> Path {
                Path(roundedRect: CGRect(x: x * s, y: midY - h * s / 2, width: w * s, height: h * s),
                     cornerRadius: 8 * s)
            }
            context.fill(Path(roundedRect: CGRect(x: 40 * s, y: midY - 7 * s, width: 100 * s, height: 14 * s),
                              cornerRadius: 7 * s), with: .color(Theme.ink))
            for path in [plate(x: 8, w: 16, h: 58), plate(x: 28, w: 20, h: 84),
                         plate(x: 132, w: 20, h: 84), plate(x: 156, w: 16, h: 58)] {
                context.fill(path, with: .color(Theme.ink))
            }
        }
        .accessibilityHidden(true)
    }
}
