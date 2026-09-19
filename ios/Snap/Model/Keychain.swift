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

    private static func save(_ token: String) {
        delete()
        var query = baseQuery
        query[kSecValueData as String] = Data(token.utf8)
        // The app reads the token on a HealthKit background wake, so it has to be
        // readable while the phone is locked.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(query as CFDictionary, nil)
    }

    private static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}
