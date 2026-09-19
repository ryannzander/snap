import SwiftUI

/// The finale of onboarding: the code, huge, and the two ways to send it.
/// Linq requires the user to text first, so this isn't a formality — it's the handoff
/// to where Snap actually lives. The screen advances itself when `state.linked` flips.
struct LinkView: View {
    @Environment(AppModel.self) private var model
    @State private var pulse = false
    @State private var copiedAt: Date?
    @State private var showDebug = false

    private var imessageNumber: String? {
        guard let number = model.contact?.imessage, !number.isEmpty else { return nil }
        return number
    }

    private var telegramBot: String? {
        guard let bot = model.contact?.telegram, !bot.isEmpty else { return nil }
        return bot
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(alignment: .leading, spacing: Theme.Space.m) {
                Spacer()

                VStack(alignment: .leading, spacing: Theme.Space.m) {
                    BubbleMark(size: 76)

                    Text("last thing.\ntext snap.")
                        .font(Theme.display(40))
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .contentShape(.rect)
                // The only way out if linking is broken — otherwise the debug panel is
                // unreachable, because it normally lives behind the brain screen.
                .onLongPressGesture(minimumDuration: 0.7) { showDebug = true }

                Text("he can't text you until you text him first. send exactly this:")
                    .font(Theme.body(16))
                    .foregroundStyle(Theme.inkDim)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)

                codeCard

                Spacer()

                VStack(spacing: Theme.Space.s) {
                    if let number = imessageNumber {
                        Button("open imessage") { open(imessage: number) }
                            .buttonStyle(PillButtonStyle())
                    }
                    if let bot = telegramBot {
                        // Primary when it's the only channel; otherwise the pale secondary.
                        Button("open telegram") { open(telegram: bot) }
                            .buttonStyle(PillButtonStyle(filled: imessageNumber == nil))
                    }
                    if imessageNumber == nil && telegramBot == nil {
                        // Onboard came back without a contact. Say so; a spinner with no
                        // address to text is a dead end.
                        Text("snap didn't send a number to text. hold the wordmark to check the server.")
                            .font(Theme.body(14))
                            .foregroundStyle(Theme.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    HStack(spacing: Theme.Space.xs) {
                        ProgressView().controlSize(.small).tint(Theme.inkDim)
                        Text("waiting for your text…")
                            .font(Theme.body(14))
                            .foregroundStyle(Theme.inkDim)
                    }
                    .padding(.top, Theme.Space.xs)
                }
                .padding(.bottom, Theme.Space.m)
            }
            .padding(.horizontal, Theme.screenPad)
        }
        .sheet(isPresented: $showDebug) { DebugPanel() }
    }

    private var codeCard: some View {
        Button {
            UIPasteboard.general.string = "yo \(model.linkCode)"
            let stamp = Date.now
            withAnimation(.snappy) { copiedAt = stamp }
            // The code comes back on its own: it is the one thing the user may still
            // need to read and type, and there is nowhere else on screen that shows it.
            Task {
                try? await Task.sleep(for: .seconds(1.6))
                if copiedAt == stamp {
                    withAnimation(.snappy) { copiedAt = nil }
                }
            }
        } label: {
            HStack {
                Spacer()
                Text(copiedAt != nil ? "copied" : "yo \(model.linkCode)")
                    .font(Theme.numerals(44))
                    .foregroundStyle(Theme.ink)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .contentTransition(.opacity)
                Spacer()
            }
            .padding(.vertical, Theme.Space.l)
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.accent))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("your link code is yo \(model.linkCode). double-tap to copy.")
        .scaleEffect(pulse ? 1.015 : 1)
        .animation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true), value: pulse)
        .onAppear { pulse = true }
    }

    // MARK: - Handoff

    private func open(imessage number: String) {
        let body = "yo \(model.linkCode)".addingPercentEncoding(
            withAllowedCharacters: .alphanumerics
        ) ?? ""
        // `&body=` (not `?body=`) is what Messages actually honours for sms: URLs.
        openURL("sms:\(number)&body=\(body)")
    }

    private func open(telegram bot: String) {
        let handle = bot.hasPrefix("@") ? String(bot.dropFirst()) : bot
        openURL("https://t.me/\(handle)?start=\(model.linkCode)")
    }

    private func openURL(_ string: String) {
        guard let url = URL(string: string) else { return }
        UIApplication.shared.open(url)
    }
}
