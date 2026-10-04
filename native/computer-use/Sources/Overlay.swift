import AppKit
import QuartzCore

// Virtual cursor + "pi is using <App> · Esc to cancel" pill (docs/DESIGN.md, "Computer Use").
//
// One entry (cursor window + pill window) per app being driven. Like Codex's VirtualCursor, the windows are ordered just
// above the *target window's number* (`order(.above, relativeTo:)`), never as a full-screen top-level overlay: whatever
// covers the target also covers the cursor, so nothing ever sits over the user's other work. The windows are borderless,
// transparent, click-through, never key/main, join all Spaces, and `sharingType = .none` keeps them out of captures
// (screenshots are per-window ScreenCaptureKit images of the target anyway). The helper is an accessory app and never activates.
//
// Esc counts only when it plausibly targets the run (see `escApplies`), because the user types in other apps while pi works.

private let accent = NSColor(srgbRed: 0.2, green: 0.612, blue: 1.0, alpha: 1)   // #339cff
private let cursorSize: CGFloat = 96   // tip sits at the window center so the click ripple is centered on it

private final class OverlayWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    init(size: NSSize) {
        super.init(contentRect: NSRect(origin: .zero, size: size), styleMask: .borderless, backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        sharingType = .none
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    }
}

private final class CursorView: NSView {
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        let o = CGPoint(x: cursorSize / 2, y: cursorSize / 2)
        let pts: [(CGFloat, CGFloat)] = [(0, 0), (0, 17), (4.5, 13), (8, 21), (11, 19.5), (7.5, 12), (13, 12)]
        let path = NSBezierPath()
        for (i, p) in pts.enumerated() {
            let q = NSPoint(x: o.x + p.0, y: o.y + p.1)
            i == 0 ? path.move(to: q) : path.line(to: q)
        }
        path.close()
        accent.setFill(); path.fill()
        NSColor.white.setStroke(); path.lineWidth = 1.5; path.lineJoinStyle = .round; path.stroke()
    }

    func ripple(reduceMotion: Bool) {
        wantsLayer = true
        let ring = CAShapeLayer()
        let r: CGFloat = 22
        ring.path = CGPath(ellipseIn: CGRect(x: -r, y: -r, width: 2 * r, height: 2 * r), transform: nil)
        ring.position = CGPoint(x: cursorSize / 2, y: cursorSize / 2)
        ring.fillColor = accent.withAlphaComponent(0.25).cgColor
        ring.strokeColor = accent.cgColor
        ring.lineWidth = 2
        ring.opacity = 0
        layer?.addSublayer(ring)
        let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0.9; fade.toValue = 0
        var group: [CAAnimation] = [fade]
        if !reduceMotion {
            let scale = CABasicAnimation(keyPath: "transform.scale"); scale.fromValue = 0.2; scale.toValue = 1
            group.append(scale)
        }
        let g = CAAnimationGroup(); g.animations = group; g.duration = 0.45
        g.timingFunction = CAMediaTimingFunction(name: .easeOut)
        CATransaction.begin()
        CATransaction.setCompletionBlock { ring.removeFromSuperlayer() }
        ring.add(g, forKey: "ripple")
        CATransaction.commit()
    }
}

private final class Entry {
    let bundleId: String, pid: pid_t, name: String
    var session: String?
    var windowId: Int
    let cursor: OverlayWindow, pill: OverlayWindow
    let cursorView: CursorView
    var point: CGPoint?          // last cursor tip, global top-left points
    var pillFrame = NSRect.zero  // AppKit coordinates
    var windowFrame = NSRect.zero
    var visible = false

    init(bundleId: String, pid: pid_t, name: String, session: String?, windowId: Int, escAvailable: Bool) {
        self.bundleId = bundleId; self.pid = pid; self.name = name; self.session = session; self.windowId = windowId
        cursor = OverlayWindow(size: NSSize(width: cursorSize, height: cursorSize))
        cursorView = CursorView(frame: NSRect(x: 0, y: 0, width: cursorSize, height: cursorSize))
        cursor.contentView = cursorView

        let label = NSTextField(labelWithString: escAvailable ? "pi is using \(name) · Esc to cancel" : "pi is using \(name)")
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .white
        label.sizeToFit()
        let size = NSSize(width: label.frame.width + 28, height: 28)
        pill = OverlayWindow(size: size)
        let fx = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        fx.material = .hudWindow; fx.blendingMode = .behindWindow; fx.state = .active
        fx.wantsLayer = true; fx.layer?.cornerRadius = 14; fx.layer?.masksToBounds = true
        fx.layer?.borderWidth = 1; fx.layer?.borderColor = accent.withAlphaComponent(0.6).cgColor
        label.frame.origin = NSPoint(x: 14, y: (size.height - label.frame.height) / 2)
        fx.addSubview(label)
        pill.contentView = fx
    }
}

private struct WinInfo { var bounds: CGRect; var layer: Int; var onScreen: Bool }   // bounds: global top-left points

private func winInfo(_ id: Int) -> WinInfo? {
    guard let arr = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]],
          let d = arr.first(where: { ($0[kCGWindowNumber as String] as? Int) == id }) else { return nil }
    return info(d)
}

private func info(_ d: [String: Any]) -> WinInfo? {
    guard let b = d[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { return nil }
    return WinInfo(bounds: r, layer: d[kCGWindowLayer as String] as? Int ?? 0, onScreen: d[kCGWindowIsOnscreen as String] as? Bool ?? false)
}

/// Front-most normal on-screen window of the pid, used when the tracked window closed.
private func frontWindow(pid: pid_t) -> Int? {
    guard let arr = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for d in arr where (d[kCGWindowOwnerPID as String] as? Int32) == pid && (d[kCGWindowLayer as String] as? Int) == 0 {
        if let i = info(d), i.bounds.width > 80, i.bounds.height > 60, let n = d[kCGWindowNumber as String] as? Int { return n }
    }
    return nil
}

private func appKitRect(_ r: CGRect) -> NSRect {
    let h = NSScreen.screens.first?.frame.height ?? 0
    return NSRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height)
}

private func appKitPoint(_ p: CGPoint) -> NSPoint { NSPoint(x: p.x, y: (NSScreen.screens.first?.frame.height ?? 0) - p.y) }

final class Overlay {
    static let shared = Overlay()
    private var entries: [String: Entry] = [:]   // main thread only
    private var monitor: Any?
    private var timer: Timer?
    private var parentPid: pid_t = 0

    private func onMain<T>(_ body: () -> T) -> T {
        Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
    }

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    func isShown(_ bundleId: String) -> Bool { onMain { entries[bundleId] != nil } }

    // MARK: show / hide

    func show(_ t: InputTarget, session: String?, windowId: Int?) -> JSON {
        onMain {
            let trusted = AXIsProcessTrusted()
            parentPid = argument("--parent").flatMap { pid_t($0) } ?? 0
            if let e = entries[t.bundleId] { hideEntry(e); entries[t.bundleId] = nil }
            guard let wid = windowId ?? frontWindow(pid: t.pid) else { return ["shown": false, "reason": "no_window"] }
            let e = Entry(bundleId: t.bundleId, pid: t.pid, name: t.name, session: session, windowId: wid, escAvailable: trusted)
            entries[t.bundleId] = e
            startMonitoring()
            refresh(e)
            return ["shown": true, "escAvailable": trusted, "windowId": wid, "reducedMotion": reduceMotion]
        }
    }

    func hide(bundleId: String?) {
        onMain {
            for (id, e) in entries where bundleId == nil || bundleId == id { hideEntry(e); entries[id] = nil }
            stopMonitoringIfIdle()
        }
    }

    private func hideEntry(_ e: Entry) { e.cursor.orderOut(nil); e.pill.orderOut(nil); e.visible = false }

    // MARK: cursor

    /// Moves the agent cursor to `global` (top-left screen points) over window `wid`, optionally with a click ripple.
    /// Blocks for the move so the action that follows visibly lands where the cursor is. No-op when no overlay is shown.
    func act(bundleId: String, wid: Int?, global: CGPoint, click: Bool) {
        let wait: TimeInterval = onMain {
            guard let e = entries[bundleId] else { return 0 }
            if let wid { e.windowId = wid }
            refresh(e)
            let animate = !reduceMotion && e.point != nil && e.visible
            e.point = global
            let origin = NSPoint(x: appKitPoint(global).x - cursorSize / 2, y: appKitPoint(global).y - cursorSize / 2)
            if animate {
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.2
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    e.cursor.animator().setFrameOrigin(origin)
                }
            } else {
                e.cursor.setFrameOrigin(origin)
            }
            orderAbove(e)
            if click {
                DispatchQueue.main.asyncAfter(deadline: .now() + (animate ? 0.2 : 0)) { [weak e] in e?.cursorView.ripple(reduceMotion: self.reduceMotion) }
            }
            return animate ? 0.22 : 0.03
        }
        if wait > 0 { Thread.sleep(forTimeInterval: wait) }
    }

    // MARK: placement

    private func orderAbove(_ e: Entry) {
        guard e.visible else { return }
        e.cursor.order(.above, relativeTo: e.windowId)
        e.pill.order(.above, relativeTo: e.cursor.windowNumber)
    }

    /// Re-reads the target window (it moves, resizes, closes, changes Space) and places the pill/cursor accordingly.
    private func refresh(_ e: Entry) {
        var i = winInfo(e.windowId)
        if i == nil || i?.onScreen == false, let w = frontWindow(pid: e.pid), let n = winInfo(w) { e.windowId = w; i = n }
        guard let i, i.onScreen else {
            if e.visible { hideEntry(e) }
            return
        }
        let level = NSWindow.Level(rawValue: i.layer)
        e.cursor.level = level; e.pill.level = level
        let wf = appKitRect(i.bounds)
        e.windowFrame = wf
        let size = e.pill.frame.size
        e.pillFrame = NSRect(x: wf.midX - size.width / 2, y: wf.maxY - size.height - 6, width: size.width, height: size.height)
        e.pill.setFrameOrigin(e.pillFrame.origin)
        if !e.visible {
            e.visible = true
            let p = e.point ?? CGPoint(x: i.bounds.midX, y: i.bounds.midY)
            e.cursor.setFrameOrigin(NSPoint(x: appKitPoint(p).x - cursorSize / 2, y: appKitPoint(p).y - cursorSize / 2))
            e.point = nil   // first move after (re)appearing jumps instead of flying in from a stale place
            e.cursor.alphaValue = 1; e.pill.alphaValue = reduceMotion ? 1 : 0
            e.cursor.orderFront(nil); e.pill.orderFront(nil)   // never orderFrontRegardless: ordered relative to the target next
            if !reduceMotion { NSAnimationContext.runAnimationGroup { $0.duration = 0.2; e.pill.animator().alphaValue = 1 } }
        }
        orderAbove(e)
    }

    // MARK: Esc

    private func startMonitoring() {
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                guard let self else { return }
                for e in self.entries.values {
                    if NSRunningApplication(processIdentifier: e.pid) == nil { self.hide(bundleId: e.bundleId); notifyAppGone(e); continue }
                    self.refresh(e)
                }
            }
        }
        if monitor == nil {
            monitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] ev in
                guard ev.keyCode == 53, !ev.isARepeat,
                      ev.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.function, .capsLock]).isEmpty else { return }
                self?.escPressed()
            }
        }
    }

    private func stopMonitoringIfIdle() {
        guard entries.isEmpty else { return }
        timer?.invalidate(); timer = nil
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
    }

    /// Esc counts for an app's run when the user is evidently looking at that run: the target app is frontmost, the pointer is
    /// over the target window or its pill, or pi-gna (the parent) / the helper is frontmost. In every other case (typing in
    /// an unrelated app) the key is ignored. When pi-gna is frontmost every overlay counts, otherwise only the matching apps.
    private func escApplies(_ e: Entry, front: pid_t?, mouse: NSPoint) -> Bool {
        if let front, front == e.pid || front == getpid() || (parentPid != 0 && front == parentPid) { return true }
        return e.windowFrame.contains(mouse) || e.pillFrame.contains(mouse)
    }

    private func escPressed() {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let mouse = NSEvent.mouseLocation
        for e in Array(entries.values) where e.visible && escApplies(e, front: front, mouse: mouse) {
            entries[e.bundleId] = nil
            hideEntry(e)
            var params: JSON = ["app": e.bundleId, "name": e.name, "reason": "esc"]
            if let s = e.session { params["session"] = s }
            server?.notify("cancelled", params)
        }
        stopMonitoringIfIdle()
    }
}

private func notifyAppGone(_ e: Entry) {
    var params: JSON = ["app": e.bundleId]
    if let s = e.session { params["session"] = s }
    server?.notify("app_gone", params)
}

// MARK: RPC + action hook

/// Called by input handlers before they act: moves the agent cursor to a global point (no-op without an overlay).
func overlayAct(_ t: InputTarget, wid: Int?, global: CGPoint, click: Bool) {
    Overlay.shared.act(bundleId: t.bundleId, wid: wid, global: global, click: click)
}

func registerOverlayMethods() {
    methods["overlay_show"] = { params in
        let t = try inputTarget(params)
        let wid = (params["window_id"] as? NSNumber)?.intValue
        return Overlay.shared.show(t, session: params["session_label"] as? String ?? params["session"] as? String, windowId: wid)
    }
    methods["overlay_hide"] = { params in
        var id: String?
        if params["app"] != nil { id = try inputTarget(params).bundleId }
        Overlay.shared.hide(bundleId: id)
        return [:]
    }
}
