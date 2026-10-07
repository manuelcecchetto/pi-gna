import AppKit
import ApplicationServices
import CoreGraphics

// Background input actions (docs/DESIGN.md, "Computer Use"). Order: AX action, then synthetic events posted to the
// target pid with a window number and window-local location (SkyLight SPI). Never activates an app, never moves the cursor,
// never posts to the HID tap. What cannot be done in the background fails with background_unsupported.

// MARK: SkyLight (private, resolved once)

private typealias SetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void
private typealias PostRecordFn = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UnsafePointer<UInt8>) -> Int32

@_silgen_name("GetProcessForPID")
private func GetProcessForPID(_ pid: pid_t, _ psn: UnsafeMutablePointer<ProcessSerialNumber>) -> Int32

private struct SkyLight {
    let setWindowLocation: SetWindowLocationFn
    let postRecord: PostRecordFn
}

private let skyLight: SkyLight? = {
    guard let h = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW),
          let a = dlsym(h, "SLEventSetWindowLocation"), let b = dlsym(h, "SLPSPostEventRecordTo") else { return nil }
    return SkyLight(setWindowLocation: unsafeBitCast(a, to: SetWindowLocationFn.self),
                    postRecord: unsafeBitCast(b, to: PostRecordFn.self))
}()

// MARK: Settings

/// Default off. When on, the one case that provably needs the window on screen (hidden/minimized target) may unhide and
/// activate the app; the result then carries `foreground: true`. Set by main through `configure` (T12 wires the setting).
private var allowForeground = false
private let configLock = NSLock()
private func foregroundAllowed() -> Bool { configLock.lock(); defer { configLock.unlock() }; return allowForeground }

// MARK: Errors

private func unsupported(_ message: String, _ cause: String) -> RPCError {
    RPCError(.backgroundUnsupported, message, data: ["cause": cause, "foregroundFallback": foregroundAllowed() ? "enabled" : "disabled"])
}

private func axFail(_ what: String, _ code: AXError) -> RPCError {
    RPCError(.actionFailed, "\(what) failed (AX error \(code.rawValue)).", data: ["ax": Int(code.rawValue)])
}

private func staleError(_ index: Int) -> RPCError {
    RPCError(.staleElement, "Element \(index) is not in the latest state of this app (or is gone). Call get_app_state and use the new indexes.")
}

// MARK: Target resolution

struct InputTarget {
    var bundleId: String
    var name: String
    var pid: pid_t
}

func inputTarget(_ params: JSON) throws -> InputTarget {
    guard AXIsProcessTrusted() else {
        throw RPCError(.permissionDenied, "Accessibility permission is not granted to pi-gna Computer Use.", data: ["missing": ["accessibility"]])
    }
    let t: (bundleId: String, name: String, pid: pid_t)
    if let o = params["app"] as? JSON, let id = o["bundleId"] as? String {
        if isDeniedBundle(id) { throw deniedError(id) }
        guard let r = runningApp(bundleId: id) else { throw RPCError(.appNotFound, "\(id) is not running.") }
        t = (id, r.localizedName ?? id, r.processIdentifier)
    } else if let q = params["app"] as? String {
        t = try resolveApp(q, launch: false)
    } else {
        throw RPCError(.invalidParams, "app (name, bundle id or {bundleId}) is required")
    }
    return InputTarget(bundleId: t.bundleId, name: t.name, pid: t.pid)
}

private func int(_ params: JSON, _ key: String) -> Int? { (params[key] as? NSNumber)?.intValue }
private func num(_ params: JSON, _ key: String) -> Double? { (params[key] as? NSNumber)?.doubleValue }

private func cachedElement(_ t: InputTarget, _ params: JSON, key: String = "element_index") throws -> (el: AXUIElement, frame: CGRect, windowId: Int?, index: Int) {
    guard let index = int(params, key) else { throw RPCError(.invalidParams, "\(key) is required") }
    cacheLock.lock()
    let entry = appCaches[t.bundleId]?.elements[index]
    let wid = appCaches[t.bundleId]?.windowId
    cacheLock.unlock()
    guard let entry else { throw staleError(index) }
    var role: CFTypeRef?
    let r = AXUIElementCopyAttributeValue(entry.element, kAXRoleAttribute as CFString, &role)
    if r == .invalidUIElement || r == .cannotComplete && role == nil && axFrame(entry.element) == nil { throw staleError(index) }
    return (entry.element, axFrame(entry.element) ?? entry.frame, wid, index)
}

/// Window the action addresses: id, current logical frame (global top-left points) and the screenshot scale.
private struct ActionWindow { var id: Int; var frame: CGRect; var scale: Double }

private func actionWindow(_ t: InputTarget, _ params: JSON, preferred: Int? = nil, screenshotCoords: Bool) throws -> ActionWindow {
    captureLock.lock(); let mapping = captureMappings[t.bundleId]; captureLock.unlock()
    cacheLock.lock(); let cachedWid = appCaches[t.bundleId]?.windowId; cacheLock.unlock()
    let wid: Int
    if let w = int(params, "window_id") ?? preferred { wid = w }
    else if screenshotCoords, let m = mapping { wid = m.windowId }
    else if let w = cachedWid ?? mapping?.windowId { wid = w }
    else if let w = windowId(try pickWindow(t.pid, windowId: nil)) { wid = w }
    else { throw RPCError(.windowNotFound, "The app has no addressable window.") }
    guard let axWin = axWindows(of: t.pid).first(where: { windowId($0) == wid }), let frame = axFrame(axWin) else {
        throw RPCError(.windowNotFound, "Window \(wid) was not found. Call get_app_state for the current window.")
    }
    var scale = 1.0
    if screenshotCoords {
        guard let m = mapping, m.windowId == wid else {
            throw RPCError(.staleElement, "No screenshot of this window has been taken. Call get_app_state before using x,y coordinates.")
        }
        if abs(m.frame.width - frame.width) > 2 || abs(m.frame.height - frame.height) > 2 {
            throw RPCError(.staleElement, "The window was resized since the last screenshot. Call get_app_state again.")
        }
        scale = m.scale
    }
    return ActionWindow(id: wid, frame: frame, scale: scale)
}

/// A point from params (screenshot space) or an element center, window-relative in logical points.
private func pointTarget(_ t: InputTarget, _ params: JSON, xKey: String = "x", yKey: String = "y") throws -> (w: ActionWindow, p: CGPoint, element: (el: AXUIElement, index: Int)?) {
    if params["element_index"] != nil {
        let e = try cachedElement(t, params)
        let w = try actionWindow(t, params, preferred: e.windowId, screenshotCoords: false)
        let c = CGPoint(x: e.frame.midX - w.frame.minX, y: e.frame.midY - w.frame.minY)
        guard e.frame.width > 0, e.frame.height > 0, CGRect(origin: .zero, size: w.frame.size).contains(c) else {
            throw RPCError(.actionFailed, "Element \(e.index) is not visible inside the window.")
        }
        return (w, c, (e.el, e.index))
    }
    guard let x = num(params, xKey), let y = num(params, yKey) else {
        throw RPCError(.invalidParams, "element_index or \(xKey),\(yKey) is required")
    }
    let w = try actionWindow(t, params, screenshotCoords: true)
    let p = CGPoint(x: x / w.scale, y: y / w.scale)
    guard x >= 0, y >= 0, CGRect(origin: .zero, size: w.frame.size).contains(p) else {
        throw RPCError(.invalidParams, "Point (\(x), \(y)) is outside the window screenshot.")
    }
    return (w, p, nil)
}

// MARK: Window / desktop state

private func onScreenWindowIds() -> [Int] {
    let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [JSON]) ?? []
    return info.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.compactMap { $0[kCGWindowNumber as String] as? Int }
}

/// Throws background_unsupported when the target window is not on screen (events would be dropped silently).
private func ensureOnScreen(_ t: InputTarget, _ wid: Int) throws -> Bool {
    if onScreenWindowIds().contains(wid) { return false }
    let name = t.name
    guard foregroundAllowed(), let app = NSRunningApplication(processIdentifier: t.pid) else {
        throw unsupported("\(name)'s window is not on screen (minimized, hidden or on another Space); background input cannot reach it. Ask the user to bring it back, then retry.", "app_not_visible")
    }
    app.unhide()
    app.activate(options: [])
    for _ in 0..<20 where !onScreenWindowIds().contains(wid) { Thread.sleep(forTimeInterval: 0.1) }
    guard onScreenWindowIds().contains(wid) else {
        throw unsupported("\(name)'s window is still not on screen after the foreground fallback.", "app_not_visible")
    }
    return true
}

private let desktopLock = NSLock()

private struct DesktopSnapshot {
    var frontPid: pid_t?
    var frontWindow: AXUIElement?
    var order: [Int]
}

private func snapshotDesktop() -> DesktopSnapshot {
    let front = NSWorkspace.shared.frontmostApplication
    var win: AXUIElement?
    if let f = front, let w = attr(AXUIElementCreateApplication(f.processIdentifier), kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
        win = (w as! AXUIElement)
    }
    return DesktopSnapshot(frontPid: front?.processIdentifier, frontWindow: win, order: onScreenWindowIds())
}

/// Puts the user's window back on top after a pointer action raised the target within the same app stack. Only when the
/// frontmost app is still the snapshotted one. Returns true when the order is still different afterwards.
private func restoreZOrder(_ before: DesktopSnapshot, targetPid: pid_t) -> Bool {
    desktopLock.lock(); defer { desktopLock.unlock() }
    guard before.frontPid != targetPid, onScreenWindowIds() != before.order else { return false }
    guard let win = before.frontWindow, NSWorkspace.shared.frontmostApplication?.processIdentifier == before.frontPid else { return true }
    _ = AXUIElementPerformAction(win, kAXRaiseAction as CFString)
    Thread.sleep(forTimeInterval: 0.08)
    return onScreenWindowIds() != before.order
}

private func synthFocus(pid: pid_t, wid: Int, on: Bool) {
    guard let sl = skyLight else { return }
    var psn = ProcessSerialNumber()
    guard GetProcessForPID(pid, &psn) == 0 else { return }
    var b = [UInt8](repeating: 0, count: 0xf8)
    b[4] = 0xf8; b[8] = 0x0d; b[0x8a] = on ? 1 : 2
    withUnsafeBytes(of: UInt32(wid)) { for i in 0..<4 { b[0x3c + i] = $0[i] } }
    _ = sl.postRecord(&psn, b)
    guard on else { return }
    var k = [UInt8](repeating: 0, count: 0xf8)
    k[4] = 0xf8; k[0x3a] = 0x10
    withUnsafeBytes(of: UInt32(wid)) { for i in 0..<4 { k[0x3c + i] = $0[i] } }
    for i in 0..<16 { k[0x20 + i] = 0xff }
    usleep(40_000)
    k[8] = 1; _ = sl.postRecord(&psn, k)
    k[8] = 2; _ = sl.postRecord(&psn, k)
}

/// Runs synthetic input for a window: window on screen, believe-active + key without raising, body, undo, z-order restore.
private func background(_ t: InputTarget, wid: Int, pointer: Bool, _ body: () throws -> Void) throws -> JSON {
    guard skyLight != nil else {
        throw unsupported("Background input is unavailable on this macOS version (SkyLight symbols missing).", "skylight_missing")
    }
    let foreground = try ensureOnScreen(t, wid)
    let truelyFront = NSWorkspace.shared.frontmostApplication?.processIdentifier == t.pid
    let before = snapshotDesktop()
    if !truelyFront { synthFocus(pid: t.pid, wid: wid, on: true); usleep(60_000) }
    var failure: Error?
    do { try body() } catch { failure = error }
    usleep(100_000)
    var zChanged = false
    if pointer { zChanged = restoreZOrder(before, targetPid: t.pid) }
    if !truelyFront { synthFocus(pid: t.pid, wid: wid, on: false) }
    if let failure { throw failure }
    var out: JSON = ["method": "cgevent"]
    if zChanged { out["zOrderChanged"] = true }
    if foreground { out["foreground"] = true }
    return out
}

// MARK: Event synthesis

private func stamp(_ e: CGEvent, t: InputTarget, wid: Int, windowPoint: CGPoint?) {
    e.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(wid))
    e.setIntegerValueField(CGEventField(rawValue: 40)!, value: Int64(t.pid))
    if let p = windowPoint { skyLight?.setWindowLocation(e, p) }
    e.postToPid(t.pid)
}

private enum Button { case left, right, middle
    var down: NSEvent.EventType { self == .left ? .leftMouseDown : self == .right ? .rightMouseDown : .otherMouseDown }
    var up: NSEvent.EventType { self == .left ? .leftMouseUp : self == .right ? .rightMouseUp : .otherMouseUp }
    var dragged: NSEvent.EventType { self == .left ? .leftMouseDragged : self == .right ? .rightMouseDragged : .otherMouseDragged }
}

private func mouse(_ type: NSEvent.EventType, button: Button, at p: CGPoint, w: ActionWindow, t: InputTarget, clicks: Int) throws {
    guard let ns = NSEvent.mouseEvent(with: type, location: NSPoint(x: p.x, y: w.frame.height - p.y), modifierFlags: [],
                                      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.id, context: nil,
                                      eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp || type == .rightMouseUp || type == .otherMouseUp ? 0 : 1),
          let cg = ns.cgEvent else { throw RPCError(.actionFailed, "Could not build a mouse event.") }
    if button == .middle { cg.setIntegerValueField(.mouseEventButtonNumber, value: 2) }
    stamp(cg, t: t, wid: w.id, windowPoint: p)
}

private func synthClick(_ t: InputTarget, _ w: ActionWindow, _ p: CGPoint, button: Button, count: Int) throws {
    for c in 1...count {
        try mouse(button.down, button: button, at: p, w: w, t: t, clicks: c); usleep(30_000)
        try mouse(button.up, button: button, at: p, w: w, t: t, clicks: c); usleep(40_000)
    }
}

private func synthDrag(_ t: InputTarget, _ w: ActionWindow, from a: CGPoint, to b: CGPoint) throws {
    try mouse(.leftMouseDown, button: .left, at: a, w: w, t: t, clicks: 1); usleep(30_000)
    for i in 1...8 {
        let f = CGFloat(i) / 8
        try mouse(.leftMouseDragged, button: .left, at: CGPoint(x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f), w: w, t: t, clicks: 1)
        usleep(15_000)
    }
    try mouse(.leftMouseUp, button: .left, at: b, w: w, t: t, clicks: 1); usleep(40_000)
}

private func synthScroll(_ t: InputTarget, _ w: ActionWindow, at p: CGPoint, dx: Int32, dy: Int32) throws {
    guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
        throw RPCError(.actionFailed, "Could not build a scroll event.")
    }
    e.location = CGPoint(x: w.frame.minX + p.x, y: w.frame.minY + p.y)
    stamp(e, t: t, wid: w.id, windowPoint: p)
}

private func postKey(_ t: InputTarget, wid: Int, vk: CGKeyCode, flags: CGEventFlags, chars: String?) throws {
    for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: nil, virtualKey: vk, keyDown: down) else { throw RPCError(.actionFailed, "Could not build a key event.") }
        e.flags = flags
        if let c = chars {
            var u = Array(c.utf16)
            e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
        }
        stamp(e, t: t, wid: wid, windowPoint: nil)
        usleep(20_000)
    }
}

// MARK: Keys

private let letterKeys: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
    ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
]

private let namedKeys: [String: (vk: CGKeyCode, flags: CGEventFlags)] = {
    var m: [String: (CGKeyCode, CGEventFlags)] = [
        "return": (36, []), "enter": (36, []), "tab": (48, []), "space": (49, []), "backspace": (51, []),
        "escape": (53, []), "esc": (53, []), "delete": (117, [.maskSecondaryFn]), "forwarddelete": (117, [.maskSecondaryFn]),
        "left": (123, [.maskSecondaryFn, .maskNumericPad]), "right": (124, [.maskSecondaryFn, .maskNumericPad]),
        "down": (125, [.maskSecondaryFn, .maskNumericPad]), "up": (126, [.maskSecondaryFn, .maskNumericPad]),
        "home": (115, [.maskSecondaryFn]), "end": (119, [.maskSecondaryFn]),
        "page_up": (116, [.maskSecondaryFn]), "prior": (116, [.maskSecondaryFn]), "pageup": (116, [.maskSecondaryFn]),
        "page_down": (121, [.maskSecondaryFn]), "next": (121, [.maskSecondaryFn]), "pagedown": (121, [.maskSecondaryFn]),
        "kp_enter": (76, [.maskNumericPad]), "kp_decimal": (65, [.maskNumericPad]), "kp_multiply": (67, [.maskNumericPad]),
        "kp_add": (69, [.maskNumericPad]), "kp_subtract": (78, [.maskNumericPad]), "kp_divide": (75, [.maskNumericPad]),
        "kp_equal": (81, [.maskNumericPad]),
        "plus": (24, []), "minus": (27, []), "equal": (24, []), "comma": (43, []), "period": (47, []), "slash": (44, []),
        "backslash": (42, []), "semicolon": (41, []), "apostrophe": (39, []), "grave": (50, []),
        "bracketleft": (33, []), "bracketright": (30, []),
    ]
    let f: [CGKeyCode] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
    for (i, vk) in f.enumerated() { m["f\(i + 1)"] = (vk, [.maskSecondaryFn]) }
    let kp: [CGKeyCode] = [82, 83, 84, 85, 86, 87, 88, 89, 91, 92]
    for (i, vk) in kp.enumerated() { m["kp_\(i)"] = (vk, [.maskNumericPad]) }
    return m
}()

private func modifierFlag(_ s: String) -> CGEventFlags? {
    switch s.lowercased() {
    case "super", "super_l", "super_r", "cmd", "command", "meta", "meta_l", "win": return .maskCommand
    case "ctrl", "control", "control_l", "control_r": return .maskControl
    case "alt", "alt_l", "alt_r", "option", "opt": return .maskAlternate
    case "shift", "shift_l", "shift_r": return .maskShift
    default: return nil
    }
}

private struct KeyChord { var vk: CGKeyCode; var flags: CGEventFlags; var chars: String?; var char: Character?; var named: Bool }

private func parseChord(_ spec: String) throws -> KeyChord {
    let parts = spec.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    guard let last = parts.last, !last.isEmpty else { throw RPCError(.invalidParams, "Invalid key \"\(spec)\"") }
    var flags: CGEventFlags = []
    for m in parts.dropLast() {
        guard let f = modifierFlag(m) else { throw RPCError(.invalidParams, "Unknown modifier \"\(m)\" in \"\(spec)\". Use ctrl, alt, shift, super/cmd.") }
        flags.insert(f)
    }
    if let f = modifierFlag(last), parts.count == 1 { // a lone modifier key press
        let vk: CGKeyCode = f == .maskCommand ? 55 : f == .maskShift ? 56 : f == .maskAlternate ? 58 : 59
        return KeyChord(vk: vk, flags: f, chars: nil, char: nil, named: true)
    }
    if let n = namedKeys[last.lowercased()] {
        let ch: Character? = ["plus": "+", "minus": "-", "equal": "=", "comma": ",", "period": ".", "slash": "/"][last.lowercased()]
        return KeyChord(vk: n.vk, flags: flags.union(n.flags), chars: last.lowercased() == "return" || last.lowercased() == "enter" ? "\r" : last.lowercased() == "tab" ? "\t" : last.lowercased() == "space" ? " " : nil, char: ch ?? (last.lowercased() == "space" ? " " : nil), named: ch == nil)
    }
    guard last.count == 1, let c = last.first else { throw RPCError(.invalidParams, "Unknown key \"\(last)\". Use xdotool names such as Return, Tab, Escape, BackSpace, Up, Page_Down, F5, KP_0, or a single character.") }
    if c.isUppercase { flags.insert(.maskShift) }
    let lower = Character(c.lowercased())
    return KeyChord(vk: letterKeys[lower] ?? 0, flags: flags, chars: String(c), char: lower, named: false)
}

// MARK: Menu key equivalents (they do not fire in a background app; AXPress the matching menu item instead)

private func menuItemMatches(_ el: AXUIElement, char: Character, flags: CGEventFlags) -> Bool {
    guard let c = axString(el, kAXMenuItemCmdCharAttribute as String), c.lowercased() == String(char).lowercased() else { return false }
    let mods = (attr(el, kAXMenuItemCmdModifiersAttribute as String) as? NSNumber)?.intValue ?? 0
    var want = 0
    if flags.contains(.maskShift) { want |= 1 }
    if flags.contains(.maskAlternate) { want |= 2 }
    if flags.contains(.maskControl) { want |= 4 }
    if !flags.contains(.maskCommand) { want |= 8 }
    return mods == want
}

private func findMenuItem(_ el: AXUIElement, depth: Int, char: Character, flags: CGEventFlags) -> AXUIElement? {
    if depth > 5 { return nil }
    if axString(el, kAXRoleAttribute as String) == "AXMenuItem", menuItemMatches(el, char: char, flags: flags) { return el }
    guard let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
    for k in kids { if let f = findMenuItem(k, depth: depth + 1, char: char, flags: flags) { return f } }
    return nil
}

private func pressMenuShortcut(_ pid: pid_t, char: Character, flags: CGEventFlags) throws -> Bool {
    guard let bar = attr(AXUIElementCreateApplication(pid), kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID(),
          let item = findMenuItem(bar as! AXUIElement, depth: 0, char: char, flags: flags) else { return false }
    let r = AXUIElementPerformAction(item, kAXPressAction as CFString)
    if r != .success {
        // AXEnabled can be stale for a menu that was never opened, so the press is attempted first and the hint added on failure.
        let disabled = (attr(item, kAXEnabledAttribute) as? Bool) == false
        throw RPCError(.actionFailed, "Pressing the menu item for this shortcut failed\(disabled ? " (the item is disabled right now)" : "") (AX error \(r.rawValue)).", data: ["ax": Int(r.rawValue)])
    }
    return true
}

/// Sends one chord: menu lookup for command shortcuts, key events otherwise. Returns the method used.
private func sendChord(_ t: InputTarget, wid: Int, _ spec: String) throws -> String {
    let chord = try parseChord(spec)
    if chord.flags.contains(.maskCommand), let c = chord.char, c != " " {
        if try pressMenuShortcut(t.pid, char: c, flags: chord.flags) { return "ax" }
        throw unsupported("\"\(spec)\" has no matching menu item in \(t.name); keyboard shortcuts are not delivered to background apps. Use the menu item through click/perform_secondary_action instead.", "no_menu_item_for_shortcut")
    }
    try postKey(t, wid: wid, vk: chord.vk, flags: chord.flags, chars: chord.named ? nil : chord.chars)
    return "cgevent"
}

// MARK: Settle wait

private var lastActionAt: [String: Date] = [:]
private let settleLock = NSLock()

private func isBusy(_ pid: pid_t, wid: Int?) -> Bool {
    let app = AXUIElementCreateApplication(pid)
    var root: AXUIElement = app
    if let wid, let w = axWindows(of: pid).first(where: { windowId($0) == wid }) { root = w }
    var queue = [root], seen = 0
    while !queue.isEmpty, seen < 300 {
        let el = queue.removeFirst(); seen += 1
        if (attr(el, "AXElementBusy") as? Bool) == true { return true }
        let role = axString(el, kAXRoleAttribute as String) ?? ""
        if role == "AXBusyIndicator" { return true }
        if role == "AXProgressIndicator", attr(el, kAXValueAttribute) == nil { return true }
        if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue += kids }
    }
    return false
}

/// ~1 s, extended up to 5 s while the app looks busy. `capMs` (param `settle_ms`) lowers the baseline for scripted tests.
private func settle(_ t: InputTarget, wid: Int?, baseMs: Int = 1000) -> Bool {
    let start = Date()
    Thread.sleep(forTimeInterval: Double(baseMs) / 1000)
    var settled = true
    while isBusy(t.pid, wid: wid) {
        if Date().timeIntervalSince(start) >= 5 { settled = false; break }
        Thread.sleep(forTimeInterval: 0.15)
    }
    settleLock.lock(); lastActionAt[t.bundleId] = Date(); settleLock.unlock()
    return settled
}

/// get_app_state calls this first so a read issued right after an action still sees a settled tree.
func settleBeforeRead(bundleId: String) {
    settleLock.lock(); let last = lastActionAt[bundleId]; settleLock.unlock()
    guard let last else { return }
    let remaining = 1.0 - Date().timeIntervalSince(last)
    if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
}

private func finish(_ t: InputTarget, wid: Int?, _ params: JSON, _ result: JSON) -> JSON {
    var out = result
    out["settled"] = settle(t, wid: wid, baseMs: int(params, "settle_ms") ?? 1000)
    return out
}

// MARK: Key focus

// Keystrokes and Paste go to whatever has keyboard focus in the app, not to an element. A click does not always move it
// there: a web view embedded in a background window (an Office add-in task pane, an Electron pane) takes the click but
// not key focus, so typing landed in the document next to it while reporting success. The helper remembers the text
// element the agent last clicked, selected in or set, and refuses key input unless focus is confirmed on it.

private struct KeyTarget { var element: AXUIElement; var point: CGPoint }   // point: global, inside the element
private var keyTargets: [String: KeyTarget] = [:]
private let keyTargetLock = NSLock()
private let textEntryRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

private func axParent(_ el: AXUIElement) -> AXUIElement? {
    guard let p = attr(el, kAXParentAttribute), CFGetTypeID(p) == AXUIElementGetTypeID() else { return nil }
    return (p as! AXUIElement)
}

/// The element, or its nearest ancestor, that takes typed text (a click often hits a text run inside the field).
private func textEntry(_ el: AXUIElement?) -> AXUIElement? {
    var cur = el
    for _ in 0..<6 {
        guard let c = cur else { return nil }
        if textEntryRoles.contains(axString(c, kAXRoleAttribute as String) ?? "") { return c }
        cur = axParent(c)
    }
    return nil
}

/// Records where the agent pointed: a text element there becomes the key target, anything else clears it.
private func aimKeys(_ t: InputTarget, at el: AXUIElement?, point: CGPoint) {
    let entry = textEntry(el)
    keyTargetLock.lock(); keyTargets[t.bundleId] = entry.map { KeyTarget(element: $0, point: point) }; keyTargetLock.unlock()
}

private func aimKeys(_ t: InputTarget, atWindowPoint p: CGPoint, _ w: ActionWindow) {
    let g = CGPoint(x: w.frame.minX + p.x, y: w.frame.minY + p.y)
    var hit: AXUIElement?
    _ = AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(t.pid), Float(g.x), Float(g.y), &hit)
    aimKeys(t, at: hit, point: g)
}

/// After our own keys: focus they moved (Tab, Return in a form) is where the next keys are meant to go.
private func followKeys(_ t: InputTarget) {
    let f = focusedElement(t.pid)
    let point = f.flatMap(axFrame).map { CGPoint(x: $0.midX, y: $0.midY) } ?? .zero
    aimKeys(t, at: f, point: point)
}

private func keysReach(_ target: KeyTarget, _ focused: AXUIElement) -> Bool {
    var cur: AXUIElement? = focused
    for _ in 0..<40 {
        guard let c = cur else { break }
        if CFEqual(c, target.element) { return true }
        cur = axParent(c)
    }
    // A field that swaps in its own editor on click: focus is on another text element at the same spot.
    if textEntry(focused) != nil, let f = axFrame(focused), f.contains(target.point) { return true }
    return false
}

private func describe(_ t: InputTarget, _ el: AXUIElement) -> String {
    cacheLock.lock()
    let index = appCaches[t.bundleId]?.elements.first(where: { CFEqual($0.value.element, el) })?.key
    cacheLock.unlock()
    let role = axString(el, kAXRoleAttribute as String) ?? "element"
    let name = [kAXTitleAttribute, kAXDescriptionAttribute].lazy.compactMap { axString(el, $0 as String) }.first(where: { !$0.isEmpty })
    return (index.map { "[\($0)] " } ?? "") + role + (name.map { " \"\($0)\"" } ?? "")
}

/// Before key input: throws, with nothing sent, unless keyboard focus is confirmed on the text element the agent aimed at
/// (AX focus is tried first). An app that reports no focus fails too: Word then still routes keys to its document while
/// the add-in pane's textarea claims AXFocused. Returns where the keys go, for the result.
private func ensureKeyFocus(_ t: InputTarget, sending what: String) throws -> String? {
    keyTargetLock.lock(); let target = keyTargets[t.bundleId]; keyTargetLock.unlock()
    guard let target, attr(target.element, kAXRoleAttribute as String) != nil else { return focusedElement(t.pid).map { describe(t, $0) } }
    if let f = focusedElement(t.pid), keysReach(target, f) { return describe(t, f) }
    _ = AXUIElementSetAttributeValue(target.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)   // in-app focus only
    usleep(150_000)
    let focused = focusedElement(t.pid)
    if let f = focused, keysReach(target, f) { return describe(t, f) }
    let goal = describe(t, target.element)
    let set = goal.hasPrefix("[") ? "computer_set_value on element \(goal.dropFirst().prefix(while: { $0 != "]" }))" : "computer_set_value on it"
    let state = focused.map { "Keyboard focus in \(t.name) is on \(describe(t, $0)), not on" } ?? "\(t.name) does not report its keyboard focus, so it is not confirmed on"
    throw unsupported("\(state) \(goal) that you last clicked, and \(what) could land elsewhere, e.g. in a document; nothing was sent. Web views embedded in a background app (Office add-in task panes, Electron panes) do not take key focus from a click. Enter the text with \(set) and press buttons by element_index instead.", "key_focus_elsewhere")
}

// MARK: Handlers

private func rawActions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

private func displayName(_ raw: String) -> String { raw == "AXPress" ? "Press" : raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw }

func registerInputMethods() {
    methods["configure"] = { params in
        configLock.lock(); defer { configLock.unlock() }
        if let v = params["allow_foreground_fallback"] as? Bool { allowForeground = v }
        return ["allowForegroundFallback": allowForeground]
    }

    methods["click"] = { params in
        let t = try inputTarget(params)
        let button: Button
        switch params["mouse_button"] as? String ?? "left" {
        case "left": button = .left
        case "right": button = .right
        case "middle": button = .middle
        default: throw RPCError(.invalidParams, "mouse_button must be left, right or middle")
        }
        let count = max(1, min(3, int(params, "click_count") ?? 1))
        var cursorMoved = false
        if params["element_index"] != nil {
            let e = try cachedElement(t, params)
            overlayAct(t, wid: e.windowId, global: CGPoint(x: e.frame.midX, y: e.frame.midY), click: true, target: e.frame.size); cursorMoved = true
            let actions = rawActions(e.el)
            // AXConfirm commits a text field's edit (and drops its focus), so it is not a click there.
            let role = axString(e.el, kAXRoleAttribute as String) ?? ""
            let textual = textEntryRoles.contains(role)
            aimKeys(t, at: e.el, point: CGPoint(x: e.frame.midX, y: e.frame.midY))
            let wanted: [String] = button == .right ? ["AXShowMenu"] : button == .middle ? [] : (count == 2 && actions.contains("AXOpen") ? ["AXOpen"] : ["AXPress", "AXPick"] + (textual ? [] : ["AXConfirm"]))
            if let action = wanted.first(where: { actions.contains($0) }) {
                var last = AXError.success
                for _ in 0..<(action == "AXOpen" ? 1 : count) { last = AXUIElementPerformAction(e.el, action as CFString) }
                if last == .success { return finish(t, wid: e.windowId, params, ["method": "ax", "action": displayName(action)]) }
                // AX refused; fall through to a synthesized click at the element center.
            }
        }
        let (w, p, hit) = try pointTarget(t, params)
        if !cursorMoved { overlayAct(t, wid: w.id, global: CGPoint(x: w.frame.minX + p.x, y: w.frame.minY + p.y), click: true) }
        if hit == nil { aimKeys(t, atWindowPoint: p, w) }
        let r = try background(t, wid: w.id, pointer: true) { try synthClick(t, w, p, button: button, count: count) }
        return finish(t, wid: w.id, params, r)
    }

    methods["drag"] = { params in
        let t = try inputTarget(params)
        guard num(params, "from_x") != nil, num(params, "to_x") != nil else { throw RPCError(.invalidParams, "from_x, from_y, to_x, to_y are required") }
        let a = try pointTarget(t, params, xKey: "from_x", yKey: "from_y")
        let b = try pointTarget(t, params, xKey: "to_x", yKey: "to_y")
        aimKeys(t, atWindowPoint: a.p, a.w)
        overlayAct(t, wid: a.w.id, global: CGPoint(x: a.w.frame.minX + a.p.x, y: a.w.frame.minY + a.p.y), click: true)
        overlayAct(t, wid: a.w.id, global: CGPoint(x: b.w.frame.minX + b.p.x, y: b.w.frame.minY + b.p.y), click: false)
        let r = try background(t, wid: a.w.id, pointer: true) { try synthDrag(t, a.w, from: a.p, to: b.p) }
        return finish(t, wid: a.w.id, params, r)
    }

    methods["scroll"] = { params in
        let t = try inputTarget(params)
        guard let dir = params["direction"] as? String, ["up", "down", "left", "right"].contains(dir) else {
            throw RPCError(.invalidParams, "direction must be up, down, left or right")
        }
        let pages = max(0.1, min(20, num(params, "pages") ?? 1))
        let (w, p, _) = try pointTarget(t, params)
        overlayAct(t, wid: w.id, global: CGPoint(x: w.frame.minX + p.x, y: w.frame.minY + p.y), click: false)
        let extent = (dir == "up" || dir == "down") ? w.frame.height : w.frame.width
        var remaining = Int(pages * extent * 0.9)
        let r = try background(t, wid: w.id, pointer: true) {
            while remaining > 0 {
                let step = Int32(min(remaining, 60)); remaining -= Int(step)
                switch dir {
                case "down": try synthScroll(t, w, at: p, dx: 0, dy: -step)
                case "up": try synthScroll(t, w, at: p, dx: 0, dy: step)
                case "right": try synthScroll(t, w, at: p, dx: -step, dy: 0)
                default: try synthScroll(t, w, at: p, dx: step, dy: 0)
                }
                usleep(12_000)
            }
        }
        return finish(t, wid: w.id, params, r)
    }

    methods["press_key"] = { params in
        let t = try inputTarget(params)
        guard let key = params["key"] as? String, !key.trimmingCharacters(in: .whitespaces).isEmpty else { throw RPCError(.invalidParams, "key is required") }
        let w = try actionWindow(t, params, screenshotCoords: false)
        let into = try ensureKeyFocus(t, sending: "\"\(key)\"")
        var method = "cgevent"
        var r = try background(t, wid: w.id, pointer: false) {
            for spec in key.split(whereSeparator: { $0 == " " }) { method = try sendChord(t, wid: w.id, String(spec)); usleep(30_000) }
        }
        r["method"] = method
        if let into { r["target"] = into }
        followKeys(t)
        return finish(t, wid: w.id, params, r)
    }

    methods["type_text"] = { params in
        let t = try inputTarget(params)
        guard let text = params["text"] as? String else { throw RPCError(.invalidParams, "text is required") }
        let w = try actionWindow(t, params, screenshotCoords: false)
        let into = try ensureKeyFocus(t, sending: "the text")
        var r = try background(t, wid: w.id, pointer: false) {
            for ch in text {
                if ch == "\n" || ch == "\r\n" { try postKey(t, wid: w.id, vk: 36, flags: [], chars: "\r") }
                else if ch == "\t" { try postKey(t, wid: w.id, vk: 48, flags: [], chars: "\t") }
                else { try postKey(t, wid: w.id, vk: 0, flags: [], chars: String(ch)) }
                usleep(6_000)
            }
        }
        if let into { r["target"] = into }
        followKeys(t)
        return finish(t, wid: w.id, params, r)
    }

    methods["set_value"] = { params in
        let t = try inputTarget(params)
        let e = try cachedElement(t, params)
        overlayAct(t, wid: e.windowId, global: CGPoint(x: e.frame.midX, y: e.frame.midY), click: false, target: e.frame.size)
        guard let value = params["value"] as? String else { throw RPCError(.invalidParams, "value (string) is required") }
        if axString(e.el, kAXSubroleAttribute as String) == "AXSecureTextField" { throw deniedError("Secure text fields") }
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(e.el, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
            throw RPCError(.actionFailed, "Element \(e.index) has a read-only value; it is not marked settable in the tree.")
        }
        let isNumber = attr(e.el, kAXValueAttribute) is NSNumber
        let newValue: CFTypeRef = isNumber ? NSNumber(value: Double(value) ?? 0) : value as CFString
        let r = AXUIElementSetAttributeValue(e.el, kAXValueAttribute as CFString, newValue)
        guard r == .success else { throw axFail("Setting the value", r) }
        aimKeys(t, at: e.el, point: CGPoint(x: e.frame.midX, y: e.frame.midY))
        return finish(t, wid: e.windowId, params, ["method": "ax"])
    }

    methods["select_text"] = { params in
        let t = try inputTarget(params)
        let e = try cachedElement(t, params)
        overlayAct(t, wid: e.windowId, global: CGPoint(x: e.frame.midX, y: e.frame.midY), click: false, target: e.frame.size)
        let type = params["selection_type"] as? String ?? "text"
        guard ["text", "cursor_before", "cursor_after"].contains(type) else { throw RPCError(.invalidParams, "selection_type must be text, cursor_before or cursor_after") }
        guard let needle = params["text"] as? String, !needle.isEmpty else { throw RPCError(.invalidParams, "text is required") }
        guard let content = attr(e.el, kAXValueAttribute) as? String else { throw RPCError(.actionFailed, "Element \(e.index) has no text value.") }
        let ns = content as NSString
        let prefix = params["prefix"] as? String ?? "", suffix = params["suffix"] as? String ?? ""
        let hit = ns.range(of: prefix + needle + suffix)
        guard hit.location != NSNotFound else {
            throw RPCError(.actionFailed, "The text \"\(needle)\"\(prefix.isEmpty && suffix.isEmpty ? "" : " with the given prefix/suffix") was not found in element \(e.index).")
        }
        let target = NSRange(location: hit.location + (prefix as NSString).length, length: (needle as NSString).length)
        var range = type == "text" ? CFRange(location: target.location, length: target.length)
            : CFRange(location: type == "cursor_before" ? target.location : target.location + target.length, length: 0)
        guard let value = AXValueCreate(.cfRange, &range) else { throw RPCError(.actionFailed, "Could not build the range.") }
        _ = AXUIElementSetAttributeValue(e.el, kAXFocusedAttribute as CFString, kCFBooleanTrue)   // in-app focus only
        let r = AXUIElementSetAttributeValue(e.el, kAXSelectedTextRangeAttribute as CFString, value)
        guard r == .success else { throw axFail("Selecting the text", r) }
        aimKeys(t, at: e.el, point: CGPoint(x: e.frame.midX, y: e.frame.midY))
        return finish(t, wid: e.windowId, params, ["method": "ax", "range": [range.location, range.length]])
    }

    methods["perform_secondary_action"] = { params in
        let t = try inputTarget(params)
        let e = try cachedElement(t, params)
        overlayAct(t, wid: e.windowId, global: CGPoint(x: e.frame.midX, y: e.frame.midY), click: false, target: e.frame.size)
        guard let action = params["action"] as? String, !action.isEmpty else { throw RPCError(.invalidParams, "action is required") }
        let raw = rawActions(e.el)
        let shown = raw.map(displayName)
        guard let name = raw.first(where: { $0 == action || displayName($0).lowercased() == action.lowercased() }) else {
            throw RPCError(.actionFailed, "Element \(e.index) does not expose \"\(action)\". Exposed actions: \(shown.isEmpty ? "none" : shown.joined(separator: ", ")).", data: ["actions": shown])
        }
        if name == kAXRaiseAction as String { throw unsupported("Raise would bring the window to the front; it is not available in the background.", "raise_is_foreground") }
        let r = AXUIElementPerformAction(e.el, name as CFString)
        guard r == .success else { throw axFail("Action \(action)", r) }
        return finish(t, wid: e.windowId, params, ["method": "ax"])
    }

    methods["paste"] = { params in
        let t = try inputTarget(params)
        guard let text = params["text"] as? String else { throw RPCError(.invalidParams, "text is required") }
        let format = params["format"] as? String ?? "text"
        guard ["text", "md", "html"].contains(format) else { throw RPCError(.invalidParams, "format must be text, md or html") }
        let w = try actionWindow(t, params, screenshotCoords: false)
        let into = try ensureKeyFocus(t, sending: "the paste")
        pasteboardLock.lock(); defer { pasteboardLock.unlock() }
        let pb = NSPasteboard.general
        let saved: [[(NSPasteboard.PasteboardType, Data)]] = (pb.pasteboardItems ?? []).map { item in
            item.types.compactMap { ty in item.data(forType: ty).map { (ty, $0) } }
        }
        pb.clearContents()
        if format == "html" {
            pb.setString(text, forType: .html)
            pb.setString(plainText(fromHTML: text), forType: .string)
        } else {
            pb.setString(text, forType: .string)
        }
        let ours = pb.changeCount
        defer {
            // Restore unless something else (the user) wrote to the clipboard in the meantime.
            if pb.changeCount == ours {
                pb.clearContents()
                for entry in saved {
                    let item = NSPasteboardItem()
                    for (ty, data) in entry { item.setData(data, forType: ty) }
                    pb.writeObjects([item])
                }
            }
        }
        // Menu route first (cmd+v itself is not delivered to background apps). An item's AXEnabled can be stale until the
        // menu was updated, and a press on a stale-disabled item does nothing, so the effect is verified through the focused
        // element's value and the text is inserted through AX (plain text) when nothing changed.
        let focused = focusedElement(t.pid)
        let before = focused.flatMap { attr($0, kAXValueAttribute) as? String }
        var method = "ax"
        var pressed = false
        var r = try background(t, wid: w.id, pointer: false) {
            pressed = (try? pressMenuShortcut(t.pid, char: "v", flags: .maskCommand)) ?? false
        }
        usleep(250_000)   // let the target read the pasteboard before it is restored
        let after = focused.flatMap { attr($0, kAXValueAttribute) as? String }
        if !pressed || (before != nil && before == after) {
            let plain = format == "html" ? plainText(fromHTML: text) : text
            guard let f = focused, AXUIElementSetAttributeValue(f, kAXSelectedTextAttribute as CFString, plain as CFString) == .success else {
                throw unsupported("Paste had no effect in \(t.name): its Paste menu item is unavailable and the focused element does not accept inserted text.", "paste_unavailable")
            }
            method = "ax_insert"
            r["formatLost"] = format == "html"
        }
        r["method"] = method
        if let into { r["target"] = into }
        followKeys(t)
        return finish(t, wid: w.id, params, r)
    }
}

private let pasteboardLock = NSLock()

private func focusedElement(_ pid: pid_t) -> AXUIElement? {
    guard let f = attr(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() else { return nil }
    return (f as! AXUIElement)
}

private func plainText(fromHTML html: String) -> String {
    var s = html.replacingOccurrences(of: "<br\\s*/?>|</p>|</div>|</li>", with: "\n", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    for (a, b) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&amp;", "&")] { s = s.replacingOccurrences(of: a, with: b) }
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}
