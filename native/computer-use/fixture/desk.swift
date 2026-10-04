import AppKit
import ApplicationServices
// Prints the user's desktop state (fixture windows excluded: their relative order is not the user's) (frontmost app, its key window, cursor, window order) so a run can prove it changed nothing.
let f = NSWorkspace.shared.frontmostApplication
var title = "?"
if let f {
    var w: CFTypeRef?
    if AXUIElementCopyAttributeValue(AXUIElementCreateApplication(f.processIdentifier), kAXFocusedWindowAttribute as CFString, &w) == .success {
        var t: CFTypeRef?
        AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &t)
        title = (t as? String) ?? "-"
    }
}
let m = NSEvent.mouseLocation
var order: [String] = []
for w in CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]] where (w[kCGWindowLayer as String] as? Int) == 0 && !((w[kCGWindowOwnerName as String] as? String) ?? "").hasPrefix("PiFixture") {
    order.append("\(w[kCGWindowNumber as String]!)")
    if order.count == 8 { break }
}
print("front=\(f?.bundleIdentifier ?? "?") keywin=\(title) mouse=\(Int(m.x)),\(Int(m.y)) z=\(order.joined(separator: ","))")
