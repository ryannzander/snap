import SwiftUI

/// Five pages, one idea each, then `POST /onboard`.
///
/// The order is deliberate: we ask for the cheap things first (name, goal), explain the
/// stake *before* anyone is surprised by it, and only then put up the HealthKit sheet —
/// with the reason on screen behind it.
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
    @FocusState private var nameFocused: Bool

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(spacing: 0) {
                header

                ZStack {
                    switch page {
                    case .hello:  HelloPage()
                    case .name:   NamePage(name: $name, focused: $nameFocused)
                    case .goal:   GoalPage(goal: $goal)
                    case .deal:   DealPage()
                    case .health: HealthPage()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.asymmetric(
                    insertion: .offset(x: 40).combined(with: .opacity),
                    removal: .offset(x: -40).combined(with: .opacity)
                ))
                .id(page)

                footer
            }
            .padding(.horizontal, Theme.screenPad)
        }
        .animation(.snappy(duration: 0.28), value: page)
    }

    // MARK: - Chrome

    private var header: some View {
        HStack {
            Button {
                back()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .opacity(page == .hello ? 0 : 1)
            .disabled(page == .hello)

            Spacer()
            ProgressDashes(count: Page.allCases.count, index: page.rawValue)
            Spacer()

            // Balances the back chevron so the dashes sit dead centre.
            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.top, Theme.Space.xs)
    }

    private var footer: some View {
        Group {
            switch page {
            case .hello:
                Button("let's go") { advance() }
                    .buttonStyle(PillButtonStyle())
            case .health:
                VStack(spacing: Theme.Space.s) {
                    Button(model.isWorking ? "one sec…" : "connect & finish") {
                        Task { await finish() }
                    }
                    .buttonStyle(PillButtonStyle(enabled: !model.isWorking))
                    .disabled(model.isWorking)

                    Button("skip for now") { Task { await finish(health: false) } }
                        .font(Theme.body(15))
                        .foregroundStyle(Theme.inkDim)
                        .disabled(model.isWorking)
                }
            default:
                HStack {
                    Spacer()
                    Button { advance() } label: { Image(systemName: "arrow.right") }
                        .buttonStyle(CircleButtonStyle(enabled: canAdvance))
                        .disabled(!canAdvance)
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

    /// Permission first so the system sheet appears over the page explaining why.
    /// A denial still continues — the app just won't sync.
    private func finish(health: Bool = true) async {
        if health { await model.requestHealthAuthorization() }
        await model.onboard(name: name, goal: goal)
    }
}

// MARK: - Pages

private struct HelloPage: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            Spacer()
            BubbleMark(size: 76)
            Statement("meet snap.\nyour gym bro\nin your texts.")
            Caption("he knows when you said you'd go.\nand he checks.")
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct NamePage: View {
    @Binding var name: String
    @FocusState.Binding var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            Spacer()
            Statement("what do i\ncall you?")

            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                TextField("", text: $name, prompt: Text("your name").foregroundStyle(Theme.inkDim))
                    .font(Theme.display(34))
                    .foregroundStyle(Theme.ink)
                    .textContentType(.givenName)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($focused)

                Rectangle()
                    .fill(focused ? Theme.ink : Theme.hairline)
                    .frame(height: 2)
                    .animation(.snappy, value: focused)
            }

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { focused = true }
    }
}

private struct GoalPage: View {
    @Binding var goal: Int

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            Spacer()
            Statement("how many days\na week?")
            Caption("miss the number and snap has something to say about it.")

            HStack(spacing: 9) {
                ForEach(1...7, id: \.self) { day in
                    Button {
                        goal = day
                    } label: {
                        Text("\(day)")
                            .font(Theme.numerals(20))
                            .foregroundStyle(day <= goal ? Theme.ink : Theme.inkDim)
                            .frame(maxWidth: .infinity)
                            .frame(height: 58)
                            .background(
                                RoundedRectangle(cornerRadius: 16)
                                    .fill(day <= goal ? Theme.accent : Theme.surface)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .animation(.snappy(duration: 0.2), value: goal)

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DealPage: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            Spacer()
            Statement("here's\nthe deal.")

            VStack(spacing: 0) {
                DealRow(n: "1", text: "you text snap a plan.\n\u{201C}gym at 7, $5 on it\u{201D}")
                Divider().overlay(Theme.hairline)
                DealRow(n: "2", text: "he watches your workouts.\nno photos. no honor system.")
                Divider().overlay(Theme.hairline)
                DealRow(n: "3", text: "you go, you get it back.\nyou skip, he keeps it.")
            }
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.surface))

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DealRow: View {
    let n: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.s) {
            Text(n)
                .font(Theme.numerals(15))
                .foregroundStyle(Theme.ink)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Theme.accent))

            Text(text)
                .font(Theme.body(16))
                .foregroundStyle(Theme.ink)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .padding(Theme.Space.m)
    }
}

private struct HealthPage: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            Spacer()
            Image(systemName: "heart.text.square.fill")
                .font(.system(size: 62))
                .foregroundStyle(Theme.ink)
            Statement("i need to see\nyour workouts.")
            Caption("that's the whole trick — snap reads HealthKit, so he never has to ask if you went.\n\nnothing leaves your phone except the workout itself.")
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Bits

private struct Statement: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Theme.display(40))
            .foregroundStyle(Theme.ink)
            .lineSpacing(1)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct Caption: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Theme.body(16))
            .foregroundStyle(Theme.inkDim)
            .lineSpacing(4)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The wordmark's bubble, drawn rather than shipped as an asset so it scales cleanly.
struct BubbleMark: View {
    var size: CGFloat = 60

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.29)
                .fill(Theme.accent)
                .frame(width: size, height: size * 0.68)

            HStack(spacing: size * 0.04) {
                plate(0.11, 0.115)
                plate(0.16, 0.17)
                Capsule().fill(Theme.ink).frame(width: size * 0.21, height: size * 0.05)
                plate(0.16, 0.17)
                plate(0.11, 0.115)
            }
        }
        .overlay(alignment: .bottomLeading) {
            Triangle()
                .fill(Theme.accent)
                .frame(width: size * 0.16, height: size * 0.19)
                .offset(x: size * 0.13, y: size * 0.14)
        }
    }

    private func plate(_ h: CGFloat, _ w: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: size * 0.02)
            .fill(Theme.ink)
            .frame(width: size * w * 0.36, height: size * h)
    }
}

private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
        path.closeSubpath()
        return path
    }
}
