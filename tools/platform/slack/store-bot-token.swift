import Foundation
import Security

func fail(_ code: String) -> Never {
    FileHandle.standardError.write(Data("{\"ok\":false,\"error\":\"\(code)\"}\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3 else { fail("invalid_keychain_reference") }
let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let raw = String(data: input, encoding: .utf8) else { fail("invalid_slack_bot_token") }
let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
guard token.range(of: "^xoxb-[A-Za-z0-9-]{20,}$", options: .regularExpression) != nil else {
    fail("invalid_slack_bot_token")
}

let lookup: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: service,
    kSecAttrAccount: account
]
let tokenData = Data(token.utf8)
var trustedSecurity: SecTrustedApplication?
guard SecTrustedApplicationCreateFromPath("/usr/bin/security", &trustedSecurity) == errSecSuccess,
      let trustedSecurity else { fail("keychain_trust_setup_failed") }
var access: SecAccess?
guard SecAccessCreate("AICC Slack Alerts" as CFString, [trustedSecurity] as CFArray, &access) == errSecSuccess,
      let access else { fail("keychain_access_setup_failed") }
let existing = SecItemCopyMatching(lookup as CFDictionary, nil)
let status: OSStatus
if existing == errSecSuccess {
    status = SecItemUpdate(lookup as CFDictionary, [kSecValueData: tokenData, kSecAttrAccess: access] as CFDictionary)
} else if existing == errSecItemNotFound {
    var item = lookup
    item[kSecValueData] = tokenData
    item[kSecAttrAccess] = access
    status = SecItemAdd(item as CFDictionary, nil)
} else {
    fail("keychain_lookup_failed")
}

guard status == errSecSuccess else { fail("keychain_write_failed") }
FileHandle.standardOutput.write(Data("{\"ok\":true}\n".utf8))
