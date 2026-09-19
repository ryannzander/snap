import SwiftUI

/// Colours, type, and spacing. Monochrome: paper, white cards, near-black ink and one
/// soft lavender-to-rose gradient, used only where money is on the line. The whole
/// look is borrowed from a journaling app — calm, lowercase, one big card — so the gym
/// bro reads as a companion rather than a fitness dashboard.
enum Theme {

    // MARK: - Colour

    // Contrast is measured against paper, because the brain screen is mirrored to a
    // laptop and read from two metres: secondary type sits at 4.9:1 (WCAG AA), and any
    // shape that has to read as a shape gets `surfaceAlt` rather than white.
    static let bg         = Color(hex: 0xF2F2F2)  // paper
    static let surface    = Color(hex: 0xFFFFFF)  // cards
    static let surfaceAlt = Color(hex: 0xE6E6E6)  // received bubbles, secondary pill, slider rail
    static let ink        = Color(hex: 0x141414)  // primary type, primary buttons, the dark card
    static let inkSoft    = Color(hex: 0x2C2C2C)  // the dark card's lighter edge
    static let inkDim     = Color(hex: 0x6B6B6B)  // secondary type
    static let hairline   = Color(hex: 0xD9D9D9)  // dividers, unfilled dashes
    static let danger     = Color(hex: 0xD0342C)  // "late", missed
    static let dangerOnDark = Color(hex: 0xFF6B5E) // "late" on the dark card

    /// The one colour in the app. Lavender into rose, diagonal, exactly like the
    /// reference's premium accent — and reserved the same way, for the stake.
    static let gradientStart = Color(hex: 0x8C8BD8)
    static let gradientEnd   = Color(hex: 0xD990B4)
    static var gradient: LinearGradient {
        LinearGradient(colors: [gradientStart, gradientEnd], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    /// A solid stand-in for tiny pills, where a gradient just looks like a smudge.
    static let tint = Color(hex: 0xA98BC6)

    /// The dark card: black at the top-left, a touch lighter toward the bottom-right.
    static var darkCard: LinearGradient {
        LinearGradient(colors: [ink, inkSoft], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    // MARK: - Type
    //
    // The system face, bold, lowercase. It is the closest thing on an iPhone to the
    // geometric grotesk in the reference and needs no font files. Numerals are the same
    // face with tabular digits so the countdown doesn't jitter; the trace stays mono.

    static func display(_ size: CGFloat) -> Font { .system(size: size, weight: .bold) }
    static func medium(_ size: CGFloat)  -> Font { .system(size: size, weight: .semibold) }
    static func body(_ size: CGFloat)    -> Font { .system(size: size, weight: .regular) }
    static func numerals(_ size: CGFloat) -> Font { .system(size: size, weight: .bold).monospacedDigit() }
    static func mono(_ size: CGFloat)     -> Font { .system(size: size, weight: .medium, design: .monospaced) }

    // MARK: - Metrics

    enum Space {
        static let xs: CGFloat = 8
        static let s:  CGFloat = 14
        static let m:  CGFloat = 22
        static let l:  CGFloat = 34
        static let xl: CGFloat = 56
    }

    static let screenPad: CGFloat = 24
    static let cardRadius: CGFloat = 36
}

// MARK: - Buttons

/// The pill. Filled ink is the one primary per screen; `pale` is the quiet second
/// choice; `outline` lives inside white cards; `onDark` lives on the dark card;
/// `gradient` is the stake's colour and appears only where money is being put down.
struct PillButtonStyle: ButtonStyle {
    enum Kind { case filled, pale, outline, onDark, gradient }
    var kind: Kind = .filled
    var enabled = true
    var wide = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.medium(18))
            .foregroundStyle(foreground)
            .frame(maxWidth: wide ? .infinity : nil)
            .padding(.horizontal, wide ? 20 : 30)
            .padding(.vertical, 18)
            .background(background)
            .overlay {
                if kind == .outline {
                    Capsule().stroke(Theme.hairline, lineWidth: 1.5)
                }
            }
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.3)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }

    private var foreground: Color {
        switch kind {
        case .filled, .gradient: Theme.surface
        case .pale, .outline, .onDark: Theme.ink
        }
    }

    @ViewBuilder
    private var background: some View {
        switch kind {
        case .filled:   Capsule().fill(Theme.ink)
        case .pale:     Capsule().fill(Theme.surfaceAlt)
        case .outline:  Capsule().fill(Theme.surface)
        case .onDark:   Capsule().fill(Theme.surface)
        case .gradient: Capsule().fill(Theme.gradient)
        }
    }
}

/// The circular next arrow, bottom-right. It keeps the thumb in one place for the
/// whole onboarding flow.
struct CircleButtonStyle: ButtonStyle {
    var enabled = true
    var size: CGFloat = 64

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: size * 0.34, weight: .semibold))
            .foregroundStyle(Theme.surface)
            .frame(width: size, height: size)
            .background(Circle().fill(Theme.ink))
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.2)
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

/// Chevrons and crosses in the top chrome: a bare glyph with a generous hit target.
struct ChromeButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 20, weight: .medium))
            .foregroundStyle(Theme.ink)
            .frame(width: 44, height: 44)
            .contentShape(.rect)
            .opacity(configuration.isPressed ? 0.5 : 1)
    }
}

// MARK: - Chrome

/// The progress dashes across the top of the onboarding flow: thin, quiet, the done
/// ones in ink.
struct ProgressDashes: View {
    let count: Int
    let index: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { i in
                Capsule()
                    .fill(i <= index ? Theme.ink : Theme.hairline)
                    .frame(width: 34, height: 2.5)
            }
        }
        .animation(.snappy, value: index)
    }
}

/// A tracked, capitalised caption between sections — the only uppercase in the app.
struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(Theme.medium(13))
            .tracking(3)
            .foregroundStyle(Theme.inkDim)
            .frame(maxWidth: .infinity)
    }
}

// MARK: - The mark

/// Snap himself: a speech bubble with its eyes closed, happy. Drawn rather than shipped
/// as an asset so it scales from a 22-point avatar to the full-bleed hello page, and so
/// it can be inverted for the dark card.
struct SnapMark: View {
    var size: CGFloat = 60
    var ink: Color = Theme.ink
    var eyes: Color = Theme.surface

    var body: some View {
        Canvas { context, canvas in
            // Geometry is on a 1024 grid, the same one as brand/snap-mark.svg.
            let scale = canvas.width / 1024
            let transform = CGAffineTransform(scaleX: scale, y: scale)

            // Body and tail are filled separately: as one path their windings could
            // cancel where they overlap and punch a hole in the bubble.
            let bubble = Path(roundedRect: CGRect(x: 132, y: 180, width: 760, height: 560), cornerRadius: 230)
            var tail = Path()
            tail.move(to: CGPoint(x: 318, y: 686))
            tail.addLine(to: CGPoint(x: 224, y: 866))
            tail.addLine(to: CGPoint(x: 470, y: 718))
            tail.closeSubpath()
            context.fill(tail.applying(transform), with: .color(ink))
            context.stroke(
                tail.applying(transform),
                with: .color(ink),
                style: StrokeStyle(lineWidth: 34 * scale, lineJoin: .round)
            )
            context.fill(bubble.applying(transform), with: .color(ink))

            for cx in [384.0, 640.0] {
                var arc = Path()
                arc.addArc(
                    center: CGPoint(x: cx, y: 472), radius: 60,
                    startAngle: .degrees(200), endAngle: .degrees(340), clockwise: false
                )
                context.stroke(
                    arc.applying(transform),
                    with: .color(eyes),
                    style: StrokeStyle(lineWidth: 34 * scale, lineCap: .round)
                )
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Slider

/// The reference's slider: a thick rail filled in ink up to a white thumb, snapping to
/// whole steps. `value` is the step, not a fraction, so callers bind an `Int`.
struct SnapSlider: View {
    @Binding var value: Int
    let range: ClosedRange<Int>
    var minLabel: String
    var maxLabel: String

    private let height: CGFloat = 56

    var body: some View {
        VStack(spacing: 10) {
            GeometryReader { geo in
                let width = geo.size.width
                let steps = CGFloat(range.count - 1)
                let fraction = steps == 0 ? 1 : CGFloat(value - range.lowerBound) / steps
                let thumbX = height / 2 + (width - height) * fraction

                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.surface)
                    Capsule().fill(Theme.ink)
                        .frame(width: thumbX + height / 2)
                    Circle()
                        .fill(Theme.surface)
                        .overlay(Circle().stroke(Theme.ink, lineWidth: 3))
                        .frame(width: height - 10, height: height - 10)
                        .position(x: thumbX, y: height / 2)
                }
                .contentShape(.rect)
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { drag in
                            let x = min(max(drag.location.x - height / 2, 0), width - height)
                            let step = Int((x / max(width - height, 1) * steps).rounded())
                            let next = range.lowerBound + step
                            if next != value {
                                value = next
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            }
                        }
                )
                .animation(.snappy(duration: 0.16), value: value)
            }
            .frame(height: height)
            .shadow(color: .black.opacity(0.05), radius: 8, y: 3)

            HStack {
                Text(minLabel)
                Spacer()
                Text(maxLabel)
            }
            .font(Theme.medium(15))
            .foregroundStyle(Theme.inkDim)
            .padding(.horizontal, 6)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityValue("\(value)")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: value = min(value + 1, range.upperBound)
            case .decrement: value = max(value - 1, range.lowerBound)
            @unknown default: break
            }
        }
    }
}

// MARK: - Cards

extension View {
    /// A white card with the big radius and the faint lift the reference gives its cards.
    func snapCard() -> some View {
        self
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.surface))
            .shadow(color: .black.opacity(0.04), radius: 16, y: 6)
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
