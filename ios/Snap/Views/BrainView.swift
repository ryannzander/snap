import SwiftUI

/// PLACEHOLDER — the real brain screen (countdown + live trace feed) is the next piece
/// of work. This exists so the app compiles and the onboarding flow can be run end to end.
struct BrainView: View {
    @Environment(AppModel.self) private var model
    @State private var showDebug = false

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            VStack(alignment: .leading, spacing: Theme.Space.m) {
                HStack {
                    BubbleMark(size: 44)
                    Text("snap")
                        .font(Theme.display(26))
                        .foregroundStyle(Theme.ink)
                        .onLongPressGesture { showDebug = true }
                    Spacer()
                }

                if let state = model.state {
                    Text("\(state.workoutsThisWeek)/\(state.weeklyGoal) this week")
                        .font(Theme.body(16))
                        .foregroundStyle(Theme.inkDim)
                }

                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        ForEach(model.events) { event in
                            HStack(alignment: .top, spacing: Theme.Space.xs) {
                                Text(event.ts.formatted(date: .omitted, time: .standard))
                                    .font(Theme.mono(11))
                                    .foregroundStyle(Theme.inkDim)
                                Text(event.summary)
                                    .font(Theme.body(14))
                                    .foregroundStyle(Theme.ink)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                Spacer()
            }
            .padding(.horizontal, Theme.screenPad)
        }
        .sheet(isPresented: $showDebug) { DebugPanel() }
    }
}
