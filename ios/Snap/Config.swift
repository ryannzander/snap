import Foundation

/// Server settings live in UserDefaults so they can be changed from the debug panel
/// without a rebuild. An empty base URL means the app runs against `MockAPI`.
enum Config {
    /// The deployed Worker. Not a secret. Clear it in the debug panel to fall back to `MockAPI`.
    static let defaultBaseURL = "https://snap.snap-backend.workers.dev"

    private static let defaults = UserDefaults.standard

    static var baseURL: String {
        get { defaults.string(forKey: "baseURL") ?? defaultBaseURL }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "baseURL") }
    }

    static var debugKey: String {
        get { defaults.string(forKey: "debugKey") ?? "" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "debugKey") }
    }

    /// The server URL the app would actually talk to, or nil when it would run the mock.
    /// Only an `http(s)` URL with a host counts: a pasted `snap.example.workers.dev`
    /// without a scheme used to slip through as a live URL and silently run the mock.
    static func serverURL(from string: String) -> URL? {
        guard let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host(), !host.isEmpty
        else { return nil }
        return url
    }

    /// True when the current settings run the scripted mock rather than a server.
    static var isMock: Bool { serverURL(from: baseURL) == nil }

    static func makeAPI(token: String?) -> SnapAPI {
        guard let url = serverURL(from: baseURL) else { return MockAPI.shared }
        return LiveAPI(baseURL: url, token: token, debugKey: debugKey)
    }
}
