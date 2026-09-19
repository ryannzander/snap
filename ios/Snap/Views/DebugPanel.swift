import SwiftUI

/// Long-press the wordmark. Everything here is for the demo, not the user.
struct DebugPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var baseURL = Config.baseURL
    @State private var debugKey = Config.debugKey
    @State private var confirmReset = false

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
                    // Reads the field, not the saved value, so it says what "save" will do —
                    // and names the mock for any URL that won't parse, not just an empty one.
                    Text(Config.serverURL(from: baseURL) == nil
                         ? "mock — not talking to a server"
                         : "live · \(Config.serverURL(from: baseURL)?.host() ?? "")")
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
                    // Two rows below the on-stage fallback button, on a phone held up to a
                    // camera: this one needs a second tap.
                    Button("reset app", role: .destructive) { confirmReset = true }
                        .confirmationDialog(
                            "wipe the session? token, link code and health anchor all go.",
                            isPresented: $confirmReset,
                            titleVisibility: .visible
                        ) {
                            Button("reset app", role: .destructive) {
                                model.reset()
                                dismiss()
                            }
                            Button("cancel", role: .cancel) {}
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
