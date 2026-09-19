import SwiftUI

/// Long-press the wordmark. Everything here is for the demo, not the user.
struct DebugPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var baseURL = Config.baseURL
    @State private var debugKey = Config.debugKey

    var body: some View {
        NavigationStack {
            Form {
                Section("server") {
                    TextField("https://snap.<account>.workers.dev", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("x-debug-key", text: $debugKey)
                    Button("save & reconnect") {
                        Config.baseURL = baseURL
                        Config.debugKey = debugKey
                        model.reloadAPI()
                    }
                    Text(Config.baseURL.isEmpty ? "empty → running on MockAPI" : "live")
                        .font(Theme.mono(12))
                        .foregroundStyle(Theme.inkDim)
                }

                Section("demo") {
                    Button("time-warp to check time") { Task { await model.timewarpToCheck() } }
                    Button("reset clock") { Task { await model.resetClock() } }
                    Button("seed demo history") { Task { await model.seedDemo() } }
                    Button("save simulated workout") { Task { await model.saveSimulatedWorkout() } }
                }

                Section("danger") {
                    Button("reset app", role: .destructive) {
                        model.reset()
                        dismiss()
                    }
                }

                Section("last error") {
                    Text(model.lastError ?? "none")
                        .font(Theme.mono(11))
                        .foregroundStyle(model.lastError == nil ? Theme.inkDim : Theme.danger)
                        .textSelection(.enabled)
                }
            }
            .navigationTitle("debug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("done") { dismiss() }
                }
            }
        }
    }
}
