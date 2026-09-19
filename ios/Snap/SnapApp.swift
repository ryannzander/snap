import SwiftUI

@main
struct SnapApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
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
    }
}
