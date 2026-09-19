import Foundation

/// Server settings live in UserDefaults so they can be changed from the debug panel
/// without a rebuild. An empty base URL means the app runs against `MockAPI`.
enum Config {
    /// Set this once the Worker is deployed. The URL is not a secret.
    static let defaultBaseURL = ""

    private static let defaults = UserDefaults.standard

    static var baseURL: String {
        get { defaults.string(forKey: "baseURL") ?? defaultBaseURL }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "baseURL") }
    }

    static var debugKey: String {
        get { defaults.string(forKey: "debugKey") ?? "" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "debugKey") }
    }

    static func makeAPI(token: String?) -> SnapAPI {
        guard let url = URL(string: baseURL), url.scheme != nil else { return MockAPI.shared }
        return LiveAPI(baseURL: url, token: token, debugKey: debugKey)
    }
}
