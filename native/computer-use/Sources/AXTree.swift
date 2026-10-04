import AppKit
import ApplicationServices

// get_app_state: indexed accessibility tree text with diffs (docs/COMPUTER_USE.md, "Accessibility tree text").

let maxElements = 1500
let maxDepth = 40
let maxTextChars = 60_000

/// Per-app cache replaced wholesale on every full read; indexes are valid only until the next read.
final class AppCache {
    var elements: [Int: (element: AXUIElement, frame: CGRect)] = [:]
    var windowId: Int?
    var lines: [String: String] = [:]   // stable key -> content (without index)
    var order: [String] = []
    var revision = 0
}
var appCaches: [String: AppCache] = [:]
let cacheLock = NSLock()

private struct Node { var depth: Int; var key: String; var content: String; var element: AXUIElement; var frame: CGRect; var focused: Bool }

private let layoutRoles: Set<String> = ["AXGroup", "AXScrollArea", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXSplitter"]
private let valueTextRoles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField", "AXStaticText"]
private let unlabeledFrameRoles: Set<String> = ["AXImage", "AXButton", "AXScrollArea", "AXCheckBox", "AXRadioButton", "AXMenuButton", "AXPopUpButton"]

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: pt, size: sz)
}

private func clip(_ s: String, _ n: Int) -> String {
    let flat = s.replacingOccurrences(of: "\n", with: "⏎")
    return flat.count > n ? String(flat.prefix(n)) + "…" : flat
}

private func label(_ el: AXUIElement) -> String {
    for a in [kAXTitleAttribute, kAXDescriptionAttribute] {
        if let s = attr(el, a) as? String, !s.isEmpty { return s }
    }
    if let t = attr(el, kAXTitleUIElementAttribute), CFGetTypeID(t) == AXUIElementGetTypeID(),
       let s = axString(t as! AXUIElement, kAXValueAttribute) ?? axString(t as! AXUIElement, kAXTitleAttribute), !s.isEmpty { return s }
    if let h = attr(el, kAXHelpAttribute) as? String, !h.isEmpty { return "help:" + h }
    return ""
}

func actionNames(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] else { return [] }
    return list.compactMap { a in
        if a == "AXPress" { return "Press" }
        if a.hasPrefix("AX") { return String(a.dropFirst(2)) }
        return nil   // custom actions use "Name:..." syntax; expose only the readable ones
    }.filter { $0 != "ScrollToVisible" }
}

private func valueText(_ el: AXUIElement, role: String) -> String? {
    guard let v = attr(el, kAXValueAttribute) else { return nil }
    if role == "AXSecureTextField" || axString(el, kAXSubroleAttribute) == "AXSecureTextField" { return "value=<hidden>" }
    if let s = v as? String {
        if s.isEmpty { return nil }
        if valueTextRoles.contains(role) {
            let flat = s.replacingOccurrences(of: "\n", with: "⏎")
            if flat.count > 200 { return "value=\"\(flat.prefix(200))…\" (truncated \(flat.count - 200) chars)" }
            return "value=\"\(flat)\""
        }
        return "value=\"\(clip(s, 200))\""
    }
    if let n = v as? NSNumber { return "value=\(n)" }
    return nil
}

private func selectedRange(_ el: AXUIElement) -> String? {
    guard let r = attr(el, kAXSelectedTextRangeAttribute), CFGetTypeID(r) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    guard AXValueGetValue(r as! AXValue, .cfRange, &range) else { return nil }
    return "selected=[\(range.location),\(range.length)]"
}

private final class Walker {
    var nodes: [Node] = []
    let window: CGRect
    let scale: Double
    let focusedEl: AXUIElement?
    var truncated = false
    init(window: CGRect, scale: Double, focused: AXUIElement?) { self.window = window; self.scale = scale; focusedEl = focused }

    func walk(_ el: AXUIElement, depth: Int, parentKey: String, ordinals: inout [String: Int], inMenu: Bool) {
        if depth > maxDepth { return }
        if nodes.count >= maxElements { truncated = true; return }
        let role = axString(el, kAXRoleAttribute) ?? "AXUnknown"
        let frame = axFrame(el)
        if let f = frame, !inMenu {
            if f.width <= 0 || f.height <= 0 { return }
            if !f.intersects(window) { return }
        }
        let lab = label(el)
        let acts = actionNames(el)
        let val = valueText(el, role: role)
        let isFocused = focusedEl.map { CFEqual($0, el) } ?? false
        let printable = !layoutRoles.contains(role) || !lab.isEmpty || !acts.isEmpty || val != nil || isFocused
        var childDepth = depth
        var key = parentKey
        if printable {
            let base = "\(role)|\(lab)"
            let ord = ordinals[base, default: 0]
            ordinals[base] = ord + 1
            key = "\(parentKey)/\(base)#\(ord)"
            var parts = [role]
            if !lab.isEmpty { parts.append("\"\(clip(lab, 120))\"") }
            if let val { parts.append(val) }
            if isFocused {
                if let sel = selectedRange(el) { parts.append(sel) }
                parts.append("focused")
            }
            var settable: DarwinBoolean = false
            if AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
               role != "AXSecureTextField" { parts.append("settable") }
            if !acts.isEmpty { parts.append("actions=[\(acts.joined(separator: ","))]") }
            if let f = frame, lab.isEmpty, unlabeledFrameRoles.contains(role) || role == "AXWindow" {
                let r = CGRect(x: (f.minX - window.minX) * scale, y: (f.minY - window.minY) * scale,
                               width: f.width * scale, height: f.height * scale)
                parts.append("(frame \(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))x\(Int(r.height)))")
            }
            nodes.append(Node(depth: depth, key: key, content: parts.joined(separator: " "), element: el, frame: frame ?? .zero, focused: isFocused))
            childDepth = depth + 1
        }
        guard let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
        var childOrdinals: [String: Int] = [:]
        let menuChildren = inMenu || role == "AXMenu"
        for k in kids {
            // Menu bar items expand only when open (AXSelected); closed menus would flood the tree.
            if role == "AXMenuBarItem", (attr(el, kAXSelectedAttribute) as? Bool) != true { break }
            walk(k, depth: childDepth, parentKey: key, ordinals: &childOrdinals, inMenu: menuChildren || role == "AXMenuBarItem")
            if truncated { return }
        }
    }
}

func targetApp(_ params: JSON) throws -> (bundleId: String, name: String, pid: pid_t) {
    if let t = params["app"] as? JSON, let id = t["bundleId"] as? String {
        if isDeniedBundle(id) { throw deniedError(id) }
        guard let r = runningApp(bundleId: id) else { return try resolveApp(id) }
        return (id, r.localizedName ?? id, r.processIdentifier)
    }
    guard let q = params["app"] as? String else { throw RPCError(.invalidParams, "app (name, bundle id or {bundleId}) is required") }
    return try resolveApp(q)
}

func pickWindow(_ pid: pid_t, windowId wanted: Int?) throws -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    let wins = axWindows(of: pid)
    if let wanted {
        if let w = wins.first(where: { windowId($0) == wanted }) { return w }
        throw RPCError(.windowNotFound, "Window \(wanted) was not found. Call list_apps for current window ids.")
    }
    for a in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
        if let w = attr(app, a), CFGetTypeID(w) == AXUIElementGetTypeID() { return w as! AXUIElement }
    }
    if let w = wins.first(where: { axString($0, kAXSubroleAttribute) == "AXStandardWindow" }) ?? wins.first { return w }
    throw RPCError(.windowNotFound, "The app has no visible window (minimized or on another Space).")
}

func registerAXMethods() {
    methods["get_app_state"] = { params in
        guard AXIsProcessTrusted() else {
            throw RPCError(.permissionDenied, "Accessibility permission is not granted to pi-gna Computer Use.", data: ["missing": ["accessibility"]])
        }
        let target = try targetApp(params)
        settleBeforeRead(bundleId: target.bundleId)
        let pid = target.pid
        let axApp = AXUIElementCreateApplication(pid)
        let window = try pickWindow(pid, windowId: (params["window_id"] as? NSNumber)?.intValue)
        let title = axString(window, kAXTitleAttribute) ?? ""
        // Defense in depth: Privacy & Security / Passwords panes are never readable.
        if target.bundleId == "com.apple.systempreferences", title.contains("Privacy") || title.contains("Password") {
            throw deniedError("This System Settings pane")
        }
        guard let wf = axFrame(window) else { throw RPCError(.windowNotFound, "The window has no frame.") }
        let scale = min(1.0, 1600.0 / max(wf.width, 1))
        let wid = windowId(window)
        var focusedEl: AXUIElement?
        if let f = attr(axApp, kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() { focusedEl = (f as! AXUIElement) }

        let w = Walker(window: wf, scale: scale, focused: focusedEl)
        var ord: [String: Int] = [:]
        w.walk(window, depth: 0, parentKey: "", ordinals: &ord, inMenu: false)
        if let bar = attr(axApp, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID(),
           let items = attr(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement] {
            var barOrd: [String: Int] = [:]
            for item in items where (axString(item, kAXTitleAttribute) ?? "") != "Apple" {
                w.walk(item, depth: 0, parentKey: "menubar", ordinals: &barOrd, inMenu: true)
            }
        }

        cacheLock.lock(); defer { cacheLock.unlock() }
        let cache = appCaches[target.bundleId] ?? AppCache()
        appCaches[target.bundleId] = cache
        let previous = cache.lines
        let previousOrder = cache.order
        let sameWindow = cache.windowId == wid
        let hadPrevious = cache.revision > 0
        cache.elements = [:]
        cache.lines = [:]
        cache.order = []
        var indexOf: [String: Int] = [:]
        var fullLines: [String] = []
        for (i, n) in w.nodes.enumerated() {
            cache.elements[i] = (n.element, n.frame)
            cache.lines[n.key] = n.content
            cache.order.append(n.key)
            indexOf[n.key] = i
            fullLines.append("\(String(repeating: "  ", count: n.depth))[\(i)] \(n.content)")
        }
        let prevRevision = cache.revision
        cache.revision += 1
        cache.windowId = wid

        let header = "App: \(target.name) (\(target.bundleId))"
        let winLine = "Window: \"\(title)\" frame=(\(Int(wf.minX)),\(Int(wf.minY)) \(Int(wf.width))x\(Int(wf.height))) scale=\(String(format: "%.2f", scale))"
        var focusLine = ""
        if let i = w.nodes.firstIndex(where: { $0.focused }) { focusLine = "Focused: [\(i)]" }
        var selected = ""
        if let f = focusedEl, let sel = attr(f, kAXSelectedTextAttribute) as? String, !sel.isEmpty {
            selected = "Selected text: \"\(clip(sel, 200))\""
        }

        var mode = "full"
        var text: String
        let disableDiff = params["disable_diff"] as? Bool ?? false
        var changedCount = 0
        var diffLines: [String] = []
        if hadPrevious, sameWindow, !disableDiff {
            for key in cache.order {
                guard let i = indexOf[key] else { continue }
                if let old = previous[key] {
                    if old != cache.lines[key] { diffLines.append("~ [\(i)] \(cache.lines[key]!)"); changedCount += 1 }
                } else { diffLines.append("+ [\(i)] \(cache.lines[key]!)"); changedCount += 1 }
            }
            for key in previousOrder where cache.lines[key] == nil {
                diffLines.append("- \(previous[key] ?? key)"); changedCount += 1
            }
            if Double(changedCount) <= 0.6 * Double(max(w.nodes.count, 1)) { mode = "diff" }
        }
        if mode == "diff" {
            var out = ["\(header)  diff vs revision=\(prevRevision)  revision=\(cache.revision)", winLine]
            out += diffLines.isEmpty ? ["(no changes)"] : diffLines
            out.append("Indexes: 0..\(max(w.nodes.count - 1, 0)) valid (renumbered; call with disable_diff for the full tree)")
            if !selected.isEmpty { out.append(selected) }
            if !focusLine.isEmpty { out.append(focusLine) }
            text = out.joined(separator: "\n")
        } else {
            var out = [header, winLine + " revision=\(cache.revision)"]
            out += fullLines
            if w.truncated { out.append("(tree truncated at \(maxElements) elements)") }
            if !selected.isEmpty { out.append(selected) }
            if !focusLine.isEmpty { out.append(focusLine) }
            text = out.joined(separator: "\n")
            if text.count > maxTextChars { text = String(text.prefix(maxTextChars)) + "\n(output truncated at \(maxTextChars) chars)" }
        }
        var result: JSON = [
            "text": text, "mode": mode, "bundleId": target.bundleId, "pid": Int(pid),
            "focusedWindowTitle": title, "revision": cache.revision, "elementCount": w.nodes.count,
            "note": "Element indexes are valid only until the next get_app_state; read state again before using an index from an older read.",
        ]
        if let wid { result["windowId"] = wid }
        if params["include_screenshot"] as? Bool ?? true {
            do {
                result["screenshot"] = try captureWindow(bundleId: target.bundleId, pid: pid, windowId: nil, preferredWindowId: wid)
            } catch let e as RPCError {
                result["screenshot"] = NSNull()
                result["screenshotError"] = e.message
            }
        }
        return result
    }
}
