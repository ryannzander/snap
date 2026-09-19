import SwiftUI

@main
struct SnapApp: App {
    @State private var model: AppModel

    init() {
        let model = AppModel()
        _model = State(initialValue: model)
        // The HealthKit observer has to be re-executed on every launch, including the
        // background launches iOS performs to deliver a workout while the phone is
        // locked. Those never show a window, so the root view's `.task` is too late.
        model.startWorkoutSyncIfOnboarded()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.light)
                .tint(Theme.ink)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            switch model.phase {
            case .onboarding: OnboardingView()
            case .linking: LinkView()
            case .live: BrainView()
            }
        }
        .animation(.snappy, value: model.phase)
        .task { await model.start() }
        #if DEBUG
        // Carries the SNAP_HKDIAG verdict out to the UI test. Zero-size and hidden from
        // sight, but present in the accessibility tree, which is the only channel a UI
        // test can read. Never rendered unless the launch hook set it.
        .overlay(alignment: .topLeading) {
            if let diagnostic = model.hkDiagnostic {
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityIdentifier("hkDiagnostic")
                    .accessibilityLabel(diagnostic)
            }
        }
        #endif
    }
}
