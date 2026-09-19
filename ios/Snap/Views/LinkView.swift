import SwiftUI

/// The finale of onboarding: the code, huge, and the two ways to send it.
/// Linq requires the user to text first, so this isn't a formality — it's the handoff
/// to where Snap actually lives. The screen advances itself when `state.linked` flips.
struct LinkView: View {
    @Environment(AppModel.self) private var model
    @State private var pulse = false

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(alignment: .leading, spacing: Theme.Space.m) {
                Spacer()

                BubbleMark(size: 76)

                Text("last thing.\ntext snap.")
                    .font(Theme.display(40))
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)

                Text("he can't text you until you text him first. send exactly this:")
                    .font(Theme.body(16))
                    .foregroundStyle(Theme.inkDim)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)

                codeCard

                Spacer()

                VStack(spacing: Theme.Space.s) {
                    if let number = model.contact?.imessage, !number.isEmpty {
                        Button("open imessage") { open(imessage: number) }
                            .buttonStyle(PillButtonStyle())
                    }
                    if let bot = model.contact?.telegram, !bot.isEmpty {
                        Button("open telegram") { open(telegram: bot) }
                            .buttonStyle(PillButtonStyle(filled: model.contact?.imessage == nil))
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
    }

    private var codeCard: some View {
        HStack {
            Spacer()
            Text("yo \(model.linkCode)")
                .font(Theme.numerals(44))
                .foregroundStyle(Theme.ink)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Spacer()
        }
        .padding(.vertical, Theme.Space.l)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.accent))
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
