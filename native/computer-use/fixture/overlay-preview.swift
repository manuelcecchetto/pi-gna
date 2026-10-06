import AppKit

// Overlay look check (scripts/computer-use-overlay-preview.mjs): compiled with every helper source but main.swift, it opens
// a sample window, shows the real overlay on it, moves and clicks the cursor and captures the screen region to PNGs.
// `--motion <style>` picks the cursor motion (Motion.swift), signature_arc by default.
// The overlay windows are made capturable here only (the helper keeps sharingType = .none).

func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
func shutdownHelper() -> Never { exit(0) }
let server: Server? = nil

let out = argument("--out") ?? "/tmp"
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let target = NSWindow(contentRect: NSRect(x: 400, y: 300, width: 640, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
target.title = "Overlay preview"
target.level = .floating
let text = NSTextField(labelWithString: "The cursor moves to each point; the second and third moves click.")
text.frame.origin = NSPoint(x: 24, y: 340); text.sizeToFit()
target.contentView?.addSubview(text)
target.orderFrontRegardless()

func capture(_ name: String) {
    let f = target.frame.insetBy(dx: -40, dy: -40)
    let top = (NSScreen.screens.first?.frame.height ?? 0) - f.maxY
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-o", "-R\(Int(f.minX)),\(Int(top)),\(Int(f.width)),\(Int(f.height))", "\(out)/overlay-\(name).png"]
    try? p.run(); p.waitUntilExit()
    print("\(out)/overlay-\(name).png")
}

DispatchQueue.global().async {
    Thread.sleep(forTimeInterval: 0.3)
    let t = InputTarget(bundleId: "preview", name: "Preview", pid: getpid())
    let motion = argument("--motion").flatMap(MotionStyle.init(rawValue:)) ?? .signatureArc
    _ = Overlay.shared.show(t, session: nil, windowId: target.windowNumber, motion: motion)
    DispatchQueue.main.sync { for w in NSApp.windows where w !== target { w.sharingType = .readOnly } }
    // Window-relative top-left points -> global top-left points.
    let origin = DispatchQueue.main.sync { CGPoint(x: target.frame.minX, y: (NSScreen.screens.first?.frame.height ?? 0) - target.frame.maxY) }
    let wid = target.windowNumber
    func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x, y: origin.y + y) }
    overlayAct(t, wid: wid, global: at(160, 160), click: false)
    Thread.sleep(forTimeInterval: 0.6); capture("1-idle")
    overlayAct(t, wid: wid, global: at(420, 260), click: true)
    Thread.sleep(forTimeInterval: 0.2); capture("2-ripple")
    Thread.sleep(forTimeInterval: 0.5)
    overlayAct(t, wid: wid, global: at(560, 120), click: true)
    Thread.sleep(forTimeInterval: 0.8); capture("3-moved")
    // A long move with a capture mid-glide: the path's arc and the hand leaning into its direction of travel.
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.18) { capture("4-mid-glide") }
    overlayAct(t, wid: wid, global: at(60, 360), click: true, target: CGSize(width: 80, height: 22))
    Thread.sleep(forTimeInterval: 0.8)
    DispatchQueue.main.async { exit(0) }
}
app.run()
