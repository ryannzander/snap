import SwiftUI

/// The money, in one screen.
///
/// Before this existed the stake was the only place money appeared, and it appeared
/// already spent: a user could read "0.05 SOL on the line" without ever having seen
/// where that SOL came from, how much was left, or how to get more. Three questions,
/// three answers, in this order — what you have, how to add to it, and where the rest
/// of it went.
///
/// Staking itself still happens in the thread. There is no "stake now" form here on
/// purpose: a commitment Snap did not negotiate is a commitment he cannot hold you to.
/// What this screen does is hand you the thread with the words already typed.
struct WalletView: View {
    @Environment(AppModel.self) private var model
    @State private var amount: TopUp = .oneTenth
    @State private var copiedAddress = false

    /// What the "add money" buttons offer. The backend takes anything from 0.01 to
    /// 1 SOL; these are the three that matter — one stake, two stakes, a week of them.
    enum TopUp: Double, CaseIterable, Identifiable {
        case oneTwentieth = 0.05
        case oneTenth = 0.1
        case quarter = 0.25

        var id: Double { rawValue }
        var label: String {
            switch self {
            case .oneTwentieth: "0.05"
            case .oneTenth:     "0.1"
            case .quarter:      "0.25"
            }
        }
    }

    private static let sol = FloatingPointFormatStyle<Double>.number.precision(.fractionLength(0...3))

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Space.m) {
                balanceCard
                addMoney
                stakeFromHere
                if !entries.isEmpty {
                    history
                }
                explainer
            }
            .padding(.horizontal, Theme.screenPad)
            .padding(.top, Theme.Space.xs)
            .padding(.bottom, Theme.Space.m)
        }
        .scrollIndicators(.hidden)
    }

    private var entries: [Wallet.Entry] { model.wallet?.entries ?? [] }

    // MARK: - Balance

    /// The one number everything else on the screen is about, and — only when there is
    /// one — what has already left the wallet for a stake.
    private var balanceCard: some View {
        VStack(spacing: Theme.Space.s) {
            SectionLabel("your wallet")

            Group {
                if let balance = model.wallet?.balanceSol {
                    Text("\(balance.formatted(Self.sol)) SOL")
                        .font(Theme.display(46))
                        .foregroundStyle(Theme.ink)
                        .contentTransition(.numericText())
                        .animation(.snappy, value: balance)
                } else if model.wallet == nil {
                    // First load. A zero here would read as "your money is gone".
                    Text("—")
                        .font(Theme.display(46))
                        .foregroundStyle(Theme.inkDim)
                } else {
                    Text("can't see the chain")
                        .font(Theme.display(26))
                        .foregroundStyle(Theme.inkDim)
                        .multilineTextAlignment(.center)
                }
            }
            .accessibilityLabel(balanceLabel)

            if let held = model.wallet?.heldSol, held > 0 {
                HStack(spacing: 6) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 12, weight: .bold))
                    Text("\(held.formatted(Self.sol)) SOL on the line")
                        .font(Theme.medium(13))
                }
                .foregroundStyle(Theme.surface)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Capsule().fill(Theme.gradient))
                .accessibilityLabel("\(held.formatted(Self.sol)) SOL locked in an open stake")
            } else {
                Text("nothing on the line right now")
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.inkDim)
            }

            if let address = model.wallet?.address {
                addressRow(address)
            }
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.l)
        .frame(maxWidth: .infinity)
        .snapCard()
    }

    private var balanceLabel: String {
        guard let wallet = model.wallet else { return "loading your balance" }
        guard let balance = wallet.balanceSol else { return "balance unavailable, can't reach the chain" }
        return "\(balance.formatted(Self.sol)) SOL in your wallet"
    }

    /// The custodial wallet's address, copyable, with the explorer behind it. The
    /// backend holds the key and we say so — here is where a Solana judge checks that
    /// the money on screen is money on devnet.
    private func addressRow(_ address: String) -> some View {
        HStack(spacing: Theme.Space.xs) {
            Button {
                UIPasteboard.general.string = address
                withAnimation(.snappy) { copiedAddress = true }
                Task {
                    try? await Task.sleep(for: .seconds(1.6))
                    withAnimation(.snappy) { copiedAddress = false }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: copiedAddress ? "checkmark" : "doc.on.doc")
                    Text(copiedAddress ? "copied" : BrainView.shorten(address))
                        .font(Theme.mono(13))
                }
            }
            .buttonStyle(PillButtonStyle(kind: .outline, wide: false))
            .accessibilityLabel("copy your wallet address")

            if let url = URL(string: "https://explorer.solana.com/address/\(address)?cluster=devnet") {
                Link(destination: url) {
                    Image(systemName: "arrow.up.right.square")
                }
                .buttonStyle(ChromeButtonStyle())
                .accessibilityLabel("view this wallet on solana explorer")
            }
        }
        .padding(.top, 2)
    }

    // MARK: - Add money

    private var addMoney: some View {
        VStack(spacing: Theme.Space.s) {
            HStack(spacing: Theme.Space.xs) {
                ForEach(TopUp.allCases) { option in
                    Button {
                        amount = option
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    } label: {
                        VStack(spacing: 2) {
                            Text(option.label)
                                .font(Theme.numerals(22))
                            Text("SOL")
                                .font(Theme.medium(12))
                                .opacity(0.65)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Space.s)
                        .foregroundStyle(amount == option ? Theme.surface : Theme.ink)
                        .background(
                            RoundedRectangle(cornerRadius: 22)
                                .fill(amount == option ? Theme.ink : Theme.surface)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(option.label) SOL")
                    .accessibilityAddTraits(amount == option ? .isSelected : [])
                }
            }

            Button(model.isToppingUp ? "adding…" : "add money") {
                Task { await model.topUp(sol: amount.rawValue) }
            }
            .buttonStyle(PillButtonStyle(kind: .gradient, enabled: !model.isToppingUp))
            .disabled(model.isToppingUp)

            if let error = model.topUpError {
                // The one error the app shows a user, because it is about their money.
                Text(error)
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.danger)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(model.isMock ? "devnet · mock, no chain" : "devnet sol, straight into your wallet")
                    .font(Theme.body(13))
                    .foregroundStyle(Theme.inkDim)
            }
        }
        .animation(.snappy, value: model.isToppingUp)
    }

    // MARK: - Staking

    /// The bridge back to the thread. Snap only stakes what he has negotiated, so this
    /// does not stake anything — it opens the thread with the sentence already written,
    /// which is the part nobody guesses on their own.
    private var stakeFromHere: some View {
        VStack(spacing: Theme.Space.xs) {
            Button("put it on a session") {
                ThreadLink.open(
                    contact: model.contact,
                    body: "gym at 7, \(amount.label) sol on it"
                )
            }
            .buttonStyle(PillButtonStyle(kind: .pale, enabled: ThreadLink.url(contact: model.contact) != nil))
            .disabled(ThreadLink.url(contact: model.contact) == nil)

            Text("opens your thread with it typed out. snap locks it when you agree —\nor tap 👍 on his offer.")
                .font(Theme.body(13))
                .foregroundStyle(Theme.inkDim)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - History

    private var history: some View {
        VStack(spacing: Theme.Space.s) {
            SectionLabel("where it went")
                .padding(.top, Theme.Space.xs)

            VStack(spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                    if index > 0 { Divider().overlay(Theme.hairline) }
                    EntryRow(entry: entry, isMock: model.isMock)
                }
            }
            .snapCard()
        }
    }

    // MARK: - Explainer

    /// The same three sentences as the thread's onboarding, because someone who scrolls
    /// here is asking the same question the thread answers on day one.
    private var explainer: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("how the money works")
                .padding(.bottom, 2)
            rule("you agree to a stake in the thread. it leaves this wallet then, not before.")
            rule("your watch says you trained — it comes straight back, all of it.")
            rule("you skip — it's gone to snap. that's the whole deal.")
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .snapCard()
        .padding(.top, Theme.Space.xs)
    }

    private func rule(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(Theme.tint)
                .frame(width: 6, height: 6)
                .padding(.top, 7)
            Text(text)
                .font(Theme.body(15))
                .foregroundStyle(Theme.inkDim)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Rows

/// One movement of money: which way it went, what it was for, and the receipt.
private struct EntryRow: View {
    let entry: Wallet.Entry
    let isMock: Bool

    private static let sol = FloatingPointFormatStyle<Double>.number.precision(.fractionLength(0...3))

    private static let day: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        return formatter
    }()

    var body: some View {
        // The row is the receipt: tapping one with a signature opens it on the
        // explorer. On the mock there is nothing behind the signature, so the row
        // is inert rather than a dead link in front of a Solana judge.
        if let signature = entry.txSig, !isMock,
           let url = URL(string: "https://explorer.solana.com/tx/\(signature)?cluster=devnet") {
            Link(destination: url) { row }
                .buttonStyle(.plain)
        } else {
            row
        }
    }

    private var row: some View {
        HStack(spacing: Theme.Space.s) {
            Image(systemName: glyph)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 26)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.label)
                    .font(Theme.medium(15))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(Self.day.string(from: entry.at))
                    if let signature = entry.txSig {
                        Text("·")
                        Text(BrainView.shorten(signature))
                            .font(Theme.mono(11))
                    }
                }
                .font(Theme.body(13))
                .foregroundStyle(Theme.inkDim)
            }

            Spacer(minLength: 0)

            Text("\(sign)\(entry.sol.formatted(Self.sol))")
                .font(Theme.numerals(16))
                .foregroundStyle(tint)
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.s)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    /// Money coming back reads the same as money arriving; only a slash and a lock
    /// take it away, and only a slash is red.
    private var sign: String {
        switch entry.kind {
        case .funded, .released: "+"
        case .held, .slashed:    "−"
        case .unknown:           ""
        }
    }

    private var tint: Color {
        switch entry.kind {
        case .slashed: Theme.danger
        case .held:    Theme.inkDim
        default:       Theme.ink
        }
    }

    private var glyph: String {
        switch entry.kind {
        case .funded:   "plus.circle.fill"
        case .held:     "lock.fill"
        case .released: "lock.open.fill"
        case .slashed:  "flame.fill"
        case .unknown:  "circle.fill"
        }
    }

    private var spoken: String {
        let amount = "\(entry.sol.formatted(Self.sol)) SOL"
        switch entry.kind {
        case .funded:   return "added \(amount), \(entry.label)"
        case .held:     return "\(amount) locked on \(entry.label)"
        case .released: return "\(amount) returned from \(entry.label)"
        case .slashed:  return "\(amount) lost on \(entry.label)"
        case .unknown:  return "\(amount), \(entry.label)"
        }
    }
}
