import AppKit
import QuartzCore

// Virtual cursor + "pi is using <App> · Esc to cancel" pill (docs/DESIGN.md, "Computer Use").
//
// One entry (glow frame window + cursor window + pill window) per app being driven. The cursor is the pigna hand of the
// pi-gna mark glowing yellow; the frame around the target window and the pill glow in pi's coral, yellow and blue.
// Like Codex's VirtualCursor, the windows are ordered just above the *target window's number* (`order(.above, relativeTo:)`), never as a full-screen top-level overlay: whatever
// covers the target also covers the cursor, so nothing ever sits over the user's other work. The windows are borderless,
// transparent, click-through, never key/main, join all Spaces, and `sharingType = .none` keeps them out of captures
// (screenshots are per-window ScreenCaptureKit images of the target anyway). The helper is an accessory app and never activates.
//
// Esc counts only when it plausibly targets the run (see `escApplies`), because the user types in other apps while pi works.

// pi's palette (the icon's glows, the spinner): coral #f09082, yellow #f1be58, blue #4d9abf.
private let piCoral = NSColor(srgbRed: 0.941, green: 0.565, blue: 0.510, alpha: 1)
private let piYellow = NSColor(srgbRed: 0.945, green: 0.745, blue: 0.345, alpha: 1)
private let piBlue = NSColor(srgbRed: 0.302, green: 0.604, blue: 0.749, alpha: 1)
private let pointerGlow = NSColor(srgbRed: 1, green: 0.82, blue: 0.25, alpha: 1)
private let cursorSize: CGFloat = 160   // tip sits at the window center so the click ripple is centered on it
private let frameMargin: CGFloat = 28   // the glow frame window reaches this far past the target window
private let pillMargin: CGFloat = 16    // room for the pill's glow

/// The 🤌 of the pi-gna mark: the build copies src/renderer/src/assets/pigna-hand.svg into the bundle's Resources.
private let handImage = Bundle.main.url(forResource: "pigna-hand", withExtension: "svg").flatMap(NSImage.init(contentsOf:))

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

/// The pointer: the pigna hand mirrored and tilted so its pinched fingertips point up-left like an arrow, the
/// fingertips on the view center (the hotspot), with a yellow glow that breathes unless Reduce Motion is on.
private final class HandView: NSView {
    private static let width: CGFloat = 38
    private static let tip = CGPoint(x: 0.985, y: 0.215)   // the fingertips in the artwork, fractions from its top-left

    init(size: CGFloat, reduceMotion: Bool) {
        super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
        wantsLayer = true
        let glow = NSShadow()
        glow.shadowColor = pointerGlow; glow.shadowBlurRadius = 10; glow.shadowOffset = .zero
        shadow = glow
        if !reduceMotion, let layer {
            let breathe = CABasicAnimation(keyPath: "shadowRadius"); breathe.fromValue = 6; breathe.toValue = 12
            breathe.duration = 1.2; breathe.autoreverses = true; breathe.repeatCount = .infinity
            breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            layer.add(breathe, forKey: "breathe")
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        guard let img = handImage else { return }
        let w = Self.width, h = w * img.size.height / img.size.width
        let t = NSAffineTransform()
        t.translateX(by: bounds.midX, yBy: bounds.midY)
        t.rotate(byDegrees: 40)
        t.scaleX(by: -1, yBy: 1)
        t.concat()
        let r = NSRect(x: -Self.tip.x * w, y: -Self.tip.y * h, width: w, height: h)
        img.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
}

private final class CursorView: NSView {
    init(reduceMotion: Bool) {
        super.init(frame: NSRect(x: 0, y: 0, width: cursorSize, height: cursorSize))
        wantsLayer = true
        addSubview(HandView(size: cursorSize, reduceMotion: reduceMotion))
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    /// Click feedback under the hand: yellow, coral and blue glowing rings one after another.
    func ripple(reduceMotion: Bool) {
        guard let root = layer else { return }
        for (i, (color, r)) in [(piYellow, CGFloat(20)), (piCoral, 28), (piBlue, 36)].enumerated() {
            let ring = CAShapeLayer()
            ring.path = CGPath(ellipseIn: CGRect(x: -r, y: -r, width: 2 * r, height: 2 * r), transform: nil)
            ring.position = CGPoint(x: cursorSize / 2, y: cursorSize / 2)
            ring.fillColor = i == 0 ? color.withAlphaComponent(0.3).cgColor : nil
            ring.strokeColor = color.cgColor
            ring.lineWidth = 2.5
            ring.shadowColor = color.cgColor; ring.shadowOpacity = 1; ring.shadowRadius = 6; ring.shadowOffset = .zero
            ring.opacity = 0
            root.insertSublayer(ring, at: 0)   // under the hand
            let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 1; fade.toValue = 0
            var group: [CAAnimation] = [fade]
            if !reduceMotion {
                let scale = CABasicAnimation(keyPath: "transform.scale"); scale.fromValue = 0.2; scale.toValue = 1
                group.append(scale)
            }
            let g = CAAnimationGroup(); g.animations = group; g.duration = 0.5
            g.beginTime = CACurrentMediaTime() + Double(i) * 0.07; g.fillMode = .backwards
            g.timingFunction = CAMediaTimingFunction(name: .easeOut)
            CATransaction.begin()
            CATransaction.setCompletionBlock { ring.removeFromSuperlayer() }
            ring.add(g, forKey: "ripple")
            CATransaction.commit()
        }
    }
}

/// A rounded-rect line in pi's colors glowing outward: a conic coral/yellow/blue gradient masked by the line and by a
/// halo of stacked wider, translucent strokes (a soft falloff without a per-frame blur), clipped to outside the rect so
/// the window's content stays clear. With motion the colors flow slowly around the line and the halo breathes.
private final class PiGlowView: NSView {
    private static let haloSteps = 16
    private let gradient = CAGradientLayer(), mask = CALayer(), halo = CALayer(), outside = CAShapeLayer(), line = CAShapeLayer()
    private let inset: CGFloat, radius: CGFloat

    init(frame: NSRect, inset: CGFloat, radius: CGFloat, lineWidth: CGFloat, glow: CGFloat, reduceMotion: Bool) {
        self.inset = inset; self.radius = radius
        super.init(frame: frame)
        wantsLayer = true
        autoresizingMask = [.width, .height]
        let colors = [piCoral, piYellow, piBlue, piCoral].map(\.cgColor)
        gradient.type = .conic
        gradient.startPoint = CGPoint(x: 0.5, y: 0.5); gradient.endPoint = CGPoint(x: 0.5, y: 0)
        gradient.colors = colors
        for k in 0..<Self.haloSteps {
            let s = CAShapeLayer()
            let t = CGFloat(Self.haloSteps - k) / CGFloat(Self.haloSteps)
            s.fillColor = nil; s.strokeColor = NSColor.black.cgColor; s.opacity = 0.13
            s.lineWidth = lineWidth + 2 * glow * t * t   // denser near the line: a falloff closer to a blur's
            halo.addSublayer(s)
        }
        outside.fillRule = .evenOdd; outside.fillColor = NSColor.black.cgColor
        halo.mask = outside
        line.fillColor = nil; line.strokeColor = NSColor.black.cgColor; line.lineWidth = lineWidth
        mask.addSublayer(halo); mask.addSublayer(line)
        gradient.mask = mask
        layer?.addSublayer(gradient)
        if !reduceMotion {
            let flow = CAKeyframeAnimation(keyPath: "colors")
            flow.values = (0...3).map { k in (0...3).map { colors[($0 + k) % 3] } }
            flow.duration = 6; flow.repeatCount = .infinity; flow.calculationMode = .linear
            gradient.add(flow, forKey: "flow")
            let breathe = CABasicAnimation(keyPath: "opacity"); breathe.fromValue = 0.5; breathe.toValue = 1
            breathe.duration = 1.6; breathe.autoreverses = true; breathe.repeatCount = .infinity
            breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            halo.add(breathe, forKey: "breathe")
        }
        layout()
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let path = CGPath(roundedRect: bounds.insetBy(dx: inset, dy: inset), cornerWidth: radius, cornerHeight: radius, transform: nil)
        for l in [gradient, mask, halo, outside, line] { l.frame = bounds }
        line.path = path
        let ring = CGMutablePath(); ring.addRect(bounds); ring.addPath(path)
        outside.path = ring
        for s in halo.sublayers ?? [] { s.frame = bounds; (s as? CAShapeLayer)?.path = path }
        CATransaction.commit()
    }
}

private final class Entry {
    let bundleId: String, pid: pid_t, name: String
    var session: String?
    var windowId: Int
    let glow: OverlayWindow, cursor: OverlayWindow, pill: OverlayWindow
    let cursorView: CursorView
    var point: CGPoint?          // last cursor tip, global top-left points
    var pillFrame = NSRect.zero  // the visible pill (its window adds pillMargin for the glow), AppKit coordinates
    var windowFrame = NSRect.zero
    var visible = false

    init(bundleId: String, pid: pid_t, name: String, session: String?, windowId: Int, escAvailable: Bool, reduceMotion: Bool) {
        self.bundleId = bundleId; self.pid = pid; self.name = name; self.session = session; self.windowId = windowId
        glow = OverlayWindow(size: NSSize(width: 2 * frameMargin, height: 2 * frameMargin))
        glow.contentView = PiGlowView(frame: NSRect(origin: .zero, size: glow.frame.size), inset: frameMargin - 1, radius: 14,
                                      lineWidth: 3, glow: 22, reduceMotion: reduceMotion)
        cursor = OverlayWindow(size: NSSize(width: cursorSize, height: cursorSize))
        cursorView = CursorView(reduceMotion: reduceMotion)
        cursor.contentView = cursorView

        let label = NSTextField(labelWithString: escAvailable ? "pi is using \(name) · Esc to cancel" : "pi is using \(name)")
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .white
        label.sizeToFit()
        let size = NSSize(width: label.frame.width + 28, height: 28)
        let outer = NSSize(width: size.width + 2 * pillMargin, height: size.height + 2 * pillMargin)
        pill = OverlayWindow(size: outer)
        let content = NSView(frame: NSRect(origin: .zero, size: outer))
        let fx = NSVisualEffectView(frame: NSRect(origin: NSPoint(x: pillMargin, y: pillMargin), size: size))
        fx.material = .hudWindow; fx.blendingMode = .behindWindow; fx.state = .active
        fx.wantsLayer = true; fx.layer?.cornerRadius = 14; fx.layer?.masksToBounds = true
        label.frame.origin = NSPoint(x: 14, y: (size.height - label.frame.height) / 2)
        fx.addSubview(label)
        content.addSubview(fx)
        content.addSubview(PiGlowView(frame: content.bounds, inset: pillMargin, radius: 14, lineWidth: 2, glow: 12, reduceMotion: reduceMotion))
        pill.contentView = content
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
            let e = Entry(bundleId: t.bundleId, pid: t.pid, name: t.name, session: session, windowId: wid, escAvailable: trusted,
                          reduceMotion: reduceMotion)
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

    private func hideEntry(_ e: Entry) { e.glow.orderOut(nil); e.cursor.orderOut(nil); e.pill.orderOut(nil); e.visible = false }

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
                // animator().setFrameOrigin does not move a window; setFrame(_:display:) animates.
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.2
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    e.cursor.animator().setFrame(NSRect(origin: origin, size: e.cursor.frame.size), display: true)
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
        e.glow.order(.above, relativeTo: e.windowId)
        e.cursor.order(.above, relativeTo: e.glow.windowNumber)
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
        e.glow.level = level; e.cursor.level = level; e.pill.level = level
        let wf = appKitRect(i.bounds)
        e.windowFrame = wf
        let glowFrame = wf.insetBy(dx: -frameMargin, dy: -frameMargin)
        if e.glow.frame != glowFrame { e.glow.setFrame(glowFrame, display: true) }
        let size = NSSize(width: e.pill.frame.width - 2 * pillMargin, height: e.pill.frame.height - 2 * pillMargin)
        e.pillFrame = NSRect(x: wf.midX - size.width / 2, y: wf.maxY - size.height - 6, width: size.width, height: size.height)
        e.pill.setFrameOrigin(NSPoint(x: e.pillFrame.minX - pillMargin, y: e.pillFrame.minY - pillMargin))
        if !e.visible {
            e.visible = true
            let p = e.point ?? CGPoint(x: i.bounds.midX, y: i.bounds.midY)
            e.cursor.setFrameOrigin(NSPoint(x: appKitPoint(p).x - cursorSize / 2, y: appKitPoint(p).y - cursorSize / 2))
            e.point = nil   // first move after (re)appearing jumps instead of flying in from a stale place
            e.cursor.alphaValue = 1; e.pill.alphaValue = reduceMotion ? 1 : 0; e.glow.alphaValue = reduceMotion ? 1 : 0
            // never orderFrontRegardless: ordered relative to the target next
            e.glow.orderFront(nil); e.cursor.orderFront(nil); e.pill.orderFront(nil)
            if !reduceMotion {
                NSAnimationContext.runAnimationGroup { $0.duration = 0.3; e.pill.animator().alphaValue = 1; e.glow.animator().alphaValue = 1 }
            }
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
