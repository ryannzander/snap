import SwiftUI

/// Long-press the wordmark. Everything here is for the demo, not the user.
struct DebugPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var baseURL = Config.baseURL
    @State private var debugKey = Config.debugKey
    @State private var confirmReset = false

    /// Bindings that write through the server rather than to local state: the
    /// panel must never show a position the backend does not actually have.
    private var photoMode: Binding<DemoSettings.PhotoMode> {
        Binding(
            get: { model.demo?.photoMode ?? .strict },
            set: { mode in Task { await model.setDemo(photoMode: mode) } }
        )
    }

    private var allowReplay: Binding<Bool> {
        Binding(
            get: { model.demo?.allowReplay ?? false },
            set: { on in Task { await model.setDemo(allowReplay: on) } }
        )
    }

    /// What the switch actually does, in the panel, so nobody has to remember.
    static func explain(_ demo: DemoSettings?) -> String {
        switch demo?.photoMode {
        case .lenient:
            return "rescues \"can't tell\" only — a screenshot is still refused. the trace says \"demo mode\" when it changes an outcome."
        case .always:
            return "anything that loads counts, screenshots included. for a vision model that is down. every override is marked in the trace."
        case .strict, .unknown, nil:
            return "ship behaviour: the vision model's word, unassisted."
        }
    }

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

                // The stage valve. Lives above the rest of the demo controls
                // because it is the one that decides whether the closing beat
                // can happen at all: the photo is the verifier now, and a
                // vision model that hedges at a real gym selfie is the most
                // likely way this demo dies in front of judges.
                Section("photo verification") {
                    Picker("photos", selection: photoMode) {
                        Text("strict").tag(DemoSettings.PhotoMode.strict)
                        Text("lenient").tag(DemoSettings.PhotoMode.lenient)
                        Text("always").tag(DemoSettings.PhotoMode.always)
                    }
                    .pickerStyle(.segmented)

                    Toggle("allow reused photos", isOn: allowReplay)

                    Text(Self.explain(model.demo))
                        .font(Theme.body(12))
                        .foregroundStyle(Theme.inkDim)
                }

                Section("demo") {
                    Button("time-warp to check time") { Task { await model.timewarpToCheck() } }
                    Button("reset clock") { Task { await model.resetClock() } }
                    Button("seed demo history") { Task { await model.seedDemo() } }
                    Button("save simulated workout") { Task { await model.saveSimulatedWorkout() } }
                    // The session clock, 31 minutes further along than it is. Starts one
                    // if none is running; then "done" on the plan card releases the stake.
                    Button(model.sessionStartedAt == nil
                           ? "time-warp session (start 31 min ago)"
                           : "time-warp session (+31 min)") {
                        model.warpSession()
                        dismiss()
                    }
                }

                Section("danger") {
                    // Two rows below the on-stage fallback button, on a phone held up to a
                    // camera: this one needs a second tap. The dialog itself hangs off the
                    // Form, not off this row — see below.
                    Button("reset app", role: .destructive) { confirmReset = true }
                }

                Section("last error") {
                    Text(model.lastError ?? "none")
                        .font(Theme.mono(11))
                        .foregroundStyle(model.lastError == nil ? Theme.inkDim : Theme.danger)
                        .textSelection(.enabled)
                }
            }
            // Deliberately on the Form rather than on the button that sets the flag.
            // A confirmation dialog attached to a row inside a Form hangs off a view
            // the lazy container is free to recycle, and when it does the dialog never
            // presents — the button reads as dead. Nothing was wrong with the reset
            // itself; it was never being reached.
            .confirmationDialog(
                "wipe the session? token, link code and health anchor all go.",
                isPresented: $confirmReset,
                titleVisibility: .visible
            ) {
                Button("reset app", role: .destructive) {
                    // Dismiss first. This sheet is presented by BrainView, and reset()
                    // swaps the root to OnboardingView — pulling the presenter out from
                    // under a live sheet can leave the sheet stranded on screen, which
                    // looks exactly like a reset that did nothing. The hop lets the
                    // dismissal start before the root changes underneath it.
                    dismiss()
                    Task { @MainActor in model.reset() }
                }
                Button("cancel", role: .cancel) {}
            }
            .task { await model.loadDemoSettings() }
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
