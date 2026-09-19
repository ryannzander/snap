import Foundation
import Security

/// One generic-password item, holding the API token and nothing else.
/// Link code, contact, and name live in UserDefaults — they are not secrets.
enum Keychain {
    private static let service = "com.ryanzander.snap"
    private static let account = "apiToken"

    static var token: String? {
        get { load() }
        set {
            if let newValue, !newValue.isEmpty {
                save(newValue)
            } else {
                delete()
            }
        }
    }

    /// Non-nil when the last write did not succeed. A token that only lives in memory
    /// works until the next launch, then the app silently re-onboards as a new user —
    /// so the failure has to be visible somewhere, and the debug panel is where.
    private(set) static var lastWriteError: String?

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else { return nil }
        return token
    }

    /// Update in place when the item exists, add it when it doesn't. Deleting first and
    /// then adding leaves a window with no token at all if the add fails.
    private static func save(_ token: String) {
        let data = Data(token.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)

        if status == errSecItemNotFound {
            var query = baseQuery
            query[kSecValueData as String] = data
            // The app reads the token on a HealthKit background wake, so it has to be
            // readable while the phone is locked. `ThisDeviceOnly` keeps a live bearer
            // token out of device backups.
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(query as CFDictionary, nil)
        }

        lastWriteError = status == errSecSuccess ? nil : "keychain save failed: OSStatus \(status)"
    }

    private static func delete() {
        let status = SecItemDelete(baseQuery as CFDictionary)
        lastWriteError = (status == errSecSuccess || status == errSecItemNotFound)
            ? nil
            : "keychain delete failed: OSStatus \(status)"
    }
}
