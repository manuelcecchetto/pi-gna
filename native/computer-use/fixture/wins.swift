import AppKit
// Prints the on-screen window stack top to bottom as "pid:number:layer:sharing" (sharing 0 = not capturable). Used by the overlay smoke checks.
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
print(list.map { "\($0[kCGWindowOwnerPID as String]!):\($0[kCGWindowNumber as String]!):\($0[kCGWindowLayer as String]!):\($0[kCGWindowSharingState as String] ?? -1)" }.joined(separator: " "))
