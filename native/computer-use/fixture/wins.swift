import AppKit
// Prints the on-screen window stack top to bottom as "pid:number:layer:sharing:x:y:w:h" (sharing 0 = not capturable; bounds in
// global top-left points). Used by the overlay smoke checks.
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
print(list.map { d -> String in
    let b = CGRect(dictionaryRepresentation: d[kCGWindowBounds as String] as! CFDictionary) ?? .zero
    return "\(d[kCGWindowOwnerPID as String]!):\(d[kCGWindowNumber as String]!):\(d[kCGWindowLayer as String]!):\(d[kCGWindowSharingState as String] ?? -1):\(Int(b.minX)):\(Int(b.minY)):\(Int(b.width)):\(Int(b.height))"
}.joined(separator: " "))
