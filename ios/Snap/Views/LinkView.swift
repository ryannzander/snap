import SwiftUI

/// The finale of onboarding: the code, huge, and the two ways to send it.
/// Linq requires the user to text first, so this isn't a formality — it's the handoff
/// to where Snap actually lives. The screen advances itself when `state.linked` flips.
struct LinkView: View {
    @Environment(AppModel.self) private var model
    @State private var pulse = false
    @State private var copiedAt: Date?
    @State private var showDebug = false

    private var imessageNumber: String? { ThreadLink.imessage(model.contact) }
    private var telegramBot: String? { ThreadLink.telegram(model.contact) }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(spacing: Theme.Space.m) {
                Spacer()

                VStack(spacing: Theme.Space.m) {
                    SnapMark(size: 120)

                    Text("last thing.\ntext snap.")
                        .font(Theme.display(38))
                        .foregroundStyle(Theme.ink)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .contentShape(.rect)
                // The only way out if linking is broken — otherwise the debug panel is
                // unreachable, because it normally lives behind the today screen.
                .onLongPressGesture(minimumDuration: 0.7) { showDebug = true }

                Text("he can't text you until you text him first.\nsend exactly this:")
                    .font(Theme.body(16))
                    .foregroundStyle(Theme.inkDim)
                    .multilineTextAlignment(.center)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)

                codeCard

                Spacer()

                VStack(spacing: Theme.Space.s) {
                    if let number = imessageNumber {
                        Button("open imessage") { ThreadLink.open(imessage: number, body: "yo \(model.linkCode)") }
                            .buttonStyle(PillButtonStyle())
                    }
                    if let bot = telegramBot {
                        // Primary when it's the only channel; otherwise the pale secondary.
                        Button("open telegram") { ThreadLink.open(telegram: bot, start: model.linkCode) }
                            .buttonStyle(PillButtonStyle(kind: imessageNumber == nil ? .filled : .pale))
                    }
                    if imessageNumber == nil && telegramBot == nil {
                        // Onboard came back without a contact. Say so; a spinner with no
                        // address to text is a dead end.
                        Text("snap didn't send a number to text. hold the mark to check the server.")
                            .font(Theme.body(14))
                            .foregroundStyle(Theme.danger)
                            .multilineTextAlignment(.center)
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

    /// The code, in the app's one colour: this is the moment the deal becomes real.
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
            VStack(spacing: 6) {
                Text(copiedAt != nil ? "copied" : "yo \(model.linkCode)")
                    .font(Theme.numerals(46))
                    .foregroundStyle(Theme.surface)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .contentTransition(.opacity)
                Text("tap to copy")
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.surface.opacity(0.75))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Space.l)
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.gradient))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("your link code is yo \(model.linkCode). double-tap to copy.")
        .scaleEffect(pulse ? 1.015 : 1)
        .animation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true), value: pulse)
        .onAppear { pulse = true }
    }
}

// MARK: - Handoff

/// The two doors into Snap's thread. Used by the link screen with the code, and by the
/// today screen's `+` and "text snap" with nothing pre-filled.
enum ThreadLink {
    static func imessage(_ contact: OnboardResponse.Contact?) -> String? {
        guard let number = contact?.imessage, !number.isEmpty else { return nil }
        return number
    }

    static func telegram(_ contact: OnboardResponse.Contact?) -> String? {
        guard let bot = contact?.telegram, !bot.isEmpty else { return nil }
        return bot
    }

    /// iMessage first, since that's where the demo lives; Telegram when it's all we have.
    static func url(contact: OnboardResponse.Contact?, body: String? = nil) -> URL? {
        if let number = imessage(contact) {
            return imessageURL(number, body: body)
        }
        if let bot = telegram(contact) {
            return telegramURL(bot, start: body)
        }
        return nil
    }

    /// Opens the thread, optionally with the message already typed. Nothing is ever
    /// sent for the user — Messages opens on a filled compose box and they hit send,
    /// which is the only honest way for the app to put words in their mouth.
    static func open(contact: OnboardResponse.Contact?, body: String? = nil) {
        guard let url = url(contact: contact, body: body) else { return }
        UIApplication.shared.open(url)
    }

    static func open(imessage number: String, body: String) {
        guard let url = imessageURL(number, body: body) else { return }
        UIApplication.shared.open(url)
    }

    static func open(telegram bot: String, start: String) {
        guard let url = telegramURL(bot, start: start) else { return }
        UIApplication.shared.open(url)
    }

    private static func imessageURL(_ number: String, body: String?) -> URL? {
        guard let body, !body.isEmpty else { return URL(string: "sms:\(number)") }
        let encoded = body.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        // `&body=` (not `?body=`) is what Messages actually honours for sms: URLs.
        return URL(string: "sms:\(number)&body=\(encoded)")
    }

    private static func telegramURL(_ bot: String, start: String?) -> URL? {
        let handle = bot.hasPrefix("@") ? String(bot.dropFirst()) : bot
        guard let start, !start.isEmpty else { return URL(string: "https://t.me/\(handle)") }
        return URL(string: "https://t.me/\(handle)?start=\(start)")
    }
}
