import Darwin
import Foundation

// Dark-readiness executable only. The production Keychain mutation was intentionally withheld:
// the sealed launch plan does not yet carry device/inode identity, and the reviewed ACL writer
// requires explicit approval. Keep the final CLI surface narrow while every valid operation fails
// closed. There is no read/export operation and no caller-selected service, account, or Keychain.
let maximumCredentialBytes = 2 * 1024 * 1024
let notEnabledExitStatus: Int32 = 78

func writeStandardError(_ value: String) {
  FileHandle.standardError.write(Data(value.utf8))
}

func refuse(_ category: String, status: Int32) -> Never {
  // Categories are fixed at each call site. Never render an OSStatus, argument, or input value.
  writeStandardError("refused:\(category)\n")
  exit(status)
}

func isAsciiAlphaNumeric(_ value: UInt32) -> Bool {
  (value >= 48 && value <= 57) ||
    (value >= 65 && value <= 90) ||
    (value >= 97 && value <= 122)
}

func isValidDispatchId(_ value: String) -> Bool {
  guard value != ".", value != "..", let first = value.unicodeScalars.first,
        isAsciiAlphaNumeric(first.value) else {
    return false
  }
  return value.unicodeScalars.allSatisfy { scalar in
    isAsciiAlphaNumeric(scalar.value) || scalar == "." || scalar == "_" || scalar == "-"
  }
}

func readBoundedStandardInput(maximumBytes: Int) -> Data? {
  var result = Data()
  while true {
    let remaining = maximumBytes + 1 - result.count
    guard remaining > 0 else {
      return nil
    }
    let chunk: Data?
    do {
      chunk = try FileHandle.standardInput.read(upToCount: min(64 * 1024, remaining))
    } catch {
      return nil
    }
    guard let chunk, !chunk.isEmpty else {
      break
    }
    result.append(chunk)
    if result.count > maximumBytes {
      return nil
    }
  }
  return result.isEmpty ? nil : result
}

guard CommandLine.arguments.count >= 2 else {
  refuse("invalid-request", status: 64)
}

switch CommandLine.arguments[1] {
case "install":
  guard CommandLine.arguments.count == 4,
        isValidDispatchId(CommandLine.arguments[2]),
        CommandLine.arguments[3].hasPrefix("/") else {
    refuse("invalid-request", status: 64)
  }
  guard readBoundedStandardInput(maximumBytes: maximumCredentialBytes) != nil else {
    refuse("input-invalid", status: 65)
  }
  refuse("not-enabled", status: notEnabledExitStatus)
case "delete":
  guard CommandLine.arguments.count == 3,
        isValidDispatchId(CommandLine.arguments[2]) else {
    refuse("invalid-request", status: 64)
  }
  refuse("not-enabled", status: notEnabledExitStatus)
default:
  refuse("invalid-request", status: 64)
}
