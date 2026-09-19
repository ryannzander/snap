import SwiftUI

/// Colours, type, and spacing. Light and high contrast: off-white paper, near-black ink,
/// one acid-lime accent used as a *fill* — lime on white is illegible as type, so it only
/// ever appears behind ink, never as it.
enum Theme {

    // MARK: - Colour

    static let bg       = Color(hex: 0xF3F3F1)  // paper
    static let surface  = Color(hex: 0xFFFFFF)  // cards
    static let ink      = Color(hex: 0x0B0C0A)  // primary type, primary buttons
    static let inkDim   = Color(hex: 0x83888C)  // secondary type
    static let hairline = Color(hex: 0xE3E3DF)  // dividers, unfilled states
    static let accent   = Color(hex: 0xC8FF1E)  // acid lime — fills only
    static let danger   = Color(hex: 0xD92E22)  // "late", slashed

    // MARK: - Type
    //
    // Avenir Next for anything the user reads as a statement — it's what the wordmark and
    // the Devpost art use, and it ships on every iPhone. SF Rounded for numerals so the
    // countdown has heavy, even digits. SF Mono for the trace.

    static func display(_ size: CGFloat) -> Font { .custom("AvenirNext-Heavy", size: size) }
    static func medium(_ size: CGFloat)  -> Font { .custom("AvenirNext-DemiBold", size: size) }
    static func body(_ size: CGFloat)    -> Font { .custom("AvenirNext-Medium", size: size) }
    static func numerals(_ size: CGFloat) -> Font { .system(size: size, weight: .heavy, design: .rounded) }
    static func mono(_ size: CGFloat)     -> Font { .system(size: size, weight: .medium, design: .monospaced) }

    // MARK: - Metrics

    enum Space {
        static let xs: CGFloat = 8
        static let s:  CGFloat = 14
        static let m:  CGFloat = 22
        static let l:  CGFloat = 34
        static let xl: CGFloat = 56
    }

    static let screenPad: CGFloat = 28
    static let cardRadius: CGFloat = 26
}

// MARK: - Buttons

/// The big ink pill. One per screen, never two.
struct PillButtonStyle: ButtonStyle {
    var filled = true
    var enabled = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.medium(19))
            .foregroundStyle(filled ? Theme.bg : Theme.ink)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 20)
            .background(
                Capsule().fill(filled ? Theme.ink : .clear)
                    .overlay(Capsule().strokeBorder(filled ? .clear : Theme.ink, lineWidth: 1.5))
            )
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.25)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

/// The circular next arrow, bottom-right. Stoic's move, and it keeps the thumb in one place
/// for the whole flow.
struct CircleButtonStyle: ButtonStyle {
    var enabled = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(Theme.bg)
            .frame(width: 66, height: 66)
            .background(Circle().fill(Theme.ink))
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.2)
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

// MARK: - Chrome

/// The progress dashes across the top of the onboarding flow.
struct ProgressDashes: View {
    let count: Int
    let index: Int

    var body: some View {
        HStack(spacing: 7) {
            ForEach(0..<count, id: \.self) { i in
                Capsule()
                    .fill(i <= index ? Theme.ink : Theme.hairline)
                    .frame(width: i == index ? 26 : 16, height: 3)
            }
        }
        .animation(.snappy, value: index)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red:   Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8)  & 0xFF) / 255,
            blue:  Double( hex        & 0xFF) / 255
        )
    }
}
