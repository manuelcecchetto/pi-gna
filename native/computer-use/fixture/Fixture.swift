import AppKit
import WebKit
// Throwaway AppKit fixture for the computer-use smoke run (scripts/computer-use-smoke.mjs --fixture); never shipped.
let logPath = ProcessInfo.processInfo.environment["FIXTURE_LOG"] ?? "/tmp/pigna-fixture/events.log"
func log(_ s: String) {
  let line = String(format: "%.3f ", Date().timeIntervalSince1970) + s + "\n"
  if let h = FileHandle(forWritingAtPath: logPath) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile() }
  else { try? line.write(toFile: logPath, atomically: false, encoding: .utf8) }
}
final class App: NSApplication {
  override func sendEvent(_ e: NSEvent) {
    let t = e.type
    if t != .mouseMoved && t != .systemDefined {
      log("EVT type=\(t.rawValue) sub=\(e.type == .appKitDefined ? "\(e.subtype.rawValue)" : "-") win=\(e.windowNumber) loc=\(e.locationInWindow) chars=\(e.type == .keyDown ? (e.characters ?? "") : "") flags=\(e.modifierFlags.rawValue & 0xffff0000) clicks=\((t == .leftMouseDown || t == .rightMouseDown) ? e.clickCount : 0) dy=\(t == .scrollWheel ? e.scrollingDeltaY : 0) active=\(isActive) key=\(keyWindow != nil)")
    }
    if t == .keyDown && e.modifierFlags.contains(.command) { log("PKE chars=\(e.charactersIgnoringModifiers ?? "nil") mainMenu=\(mainMenu?.performKeyEquivalent(with: e) ?? false) win=\(keyWindow?.performKeyEquivalent(with: e) ?? false) keyWindowNil=\(keyWindow == nil) mainWin=\(mainWindow == nil) isActive=\(isActive)") }
    super.sendEvent(e)
  }
}
final class W: NSWindow {
  override func sendEvent(_ e: NSEvent) { if e.type == .leftMouseDown || e.type == .keyDown || e.type == .scrollWheel { log("WIN sendEvent type=\(e.type.rawValue) isKey=\(isKeyWindow) hit=\(String(describing: contentView?.hitTest(e.locationInWindow).map { String(describing: type(of: $0)) }))") }; super.sendEvent(e) }
  override var canBecomeKey: Bool { true }
}
final class B: NSButton {
  override func mouseDown(with e: NSEvent) { log("BTN mouseDown"); super.mouseDown(with: e) }
  override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
}
final class TV: NSTextView {
  override func paste(_ s: Any?) { log("TVPASTE pb=\(NSPasteboard.general.string(forType: .string) ?? "nil")"); super.paste(s) }
  override func validateUserInterfaceItem(_ i: NSValidatedUserInterfaceItem) -> Bool { let r = super.validateUserInterfaceItem(i); if i.action == #selector(NSText.paste(_:)) { log("TVVALIDATE paste=\(r) editable=\(isEditable) types=\(NSPasteboard.general.types?.map { $0.rawValue } ?? []) fr=\(window?.firstResponder === self)") }; return r }
}
final class Del: NSObject, NSApplicationDelegate, NSTextFieldDelegate, NSTextViewDelegate, NSWindowDelegate, WKScriptMessageHandler {
  var win: NSWindow!
  var web: WKWebView!
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { log("WEB \(m.body)") }
  @objc func btn(_ s: Any?) { log("ACTION button") }
  @objc func chk(_ s: NSButton) { log("ACTION checkbox state=\(s.state.rawValue)") }
  @objc func menuItem(_ s: NSMenuItem) { log("ACTION menu \(s.title)") }
  func applicationDidFinishLaunching(_ n: Notification) {
    NSApp.setActivationPolicy(.regular)
    let m = NSMenu(); let a = NSMenuItem(); m.addItem(a); let am = NSMenu(); a.submenu = am
    am.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    let e = NSMenuItem(); m.addItem(e); let em = NSMenu(title: "Edit"); e.submenu = em
    em.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    em.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    let c = NSMenuItem(title: "Custom1", action: #selector(menuItem(_:)), keyEquivalent: "1"); c.target = self; em.addItem(c)
    NSApp.mainMenu = m
    win = W(contentRect: NSRect(x: ProcessInfo.processInfo.environment["FIXTURE_X"].flatMap { Double($0) } ?? 200, y: 200, width: 900, height: 480), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    win.title = "PiFixture"; win.delegate = self; win.isReleasedWhenClosed = false
    let v = win.contentView!
    let tf = NSTextField(frame: NSRect(x: 20, y: 430, width: 300, height: 24)); tf.placeholderString = "field"; tf.delegate = self; v.addSubview(tf)
    let b = B(title: "Press", target: self, action: #selector(btn(_:))); b.frame = NSRect(x: 340, y: 428, width: 90, height: 28); v.addSubview(b)
    let cb = NSButton(checkboxWithTitle: "Check", target: self, action: #selector(chk(_:))); cb.frame = NSRect(x: 450, y: 430, width: 100, height: 24); v.addSubview(cb)
    let sv = NSScrollView(frame: NSRect(x: 20, y: 20, width: 600, height: 380)); sv.hasVerticalScroller = true
    let tv = TV(frame: NSRect(x: 0, y: 0, width: 600, height: 380)); tv.isRichText = false
    tv.delegate = self
    tv.string = (1...200).map { "line \($0)" }.joined(separator: "\n")
    let cm = NSMenu(); cm.addItem(withTitle: "CtxItem", action: #selector(menuItem(_:)), keyEquivalent: "").target = self; tv.menu = cm
    sv.documentView = tv; v.addSubview(sv)
    // An embedded web pane, like an Office add-in task pane: its textarea logs what it receives.
    let cfg = WKWebViewConfiguration(); cfg.userContentController.add(self, name: "log")
    web = WKWebView(frame: NSRect(x: 640, y: 20, width: 240, height: 440), configuration: cfg)
    web.loadHTMLString("<html><body><textarea id=chat aria-label=chat rows=4 oninput=\"webkit.messageHandlers.log.postMessage('chat='+this.value)\"></textarea></body></html>", baseURL: nil)
    v.addSubview(web)
    win.orderFront(nil)   // no activation
    if let b = ProcessInfo.processInfo.environment["FIXTURE_BELOW"], let n = Int(b) { win.order(.below, relativeTo: n) }
    log("LAUNCH win=\(win.windowNumber) active=\(NSApp.isActive)")
    Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
      let s = "STATE active=\(NSApp.isActive) key=\(self.win.isKeyWindow) main=\(self.win.isMainWindow) tf=\(tf.stringValue.count) sel=\(tv.selectedRange()) scrollY=\(Int(sv.contentView.bounds.origin.y)) pb=\(NSPasteboard.general.string(forType: .string)?.prefix(8) ?? "-")"
      if s != self.last { self.last = s; log(s) }
    }
  }
  var last = ""
  func controlTextDidChange(_ n: Notification) { log("TEXT field='\((n.object as! NSTextField).stringValue)'") }
  func textDidChange(_ n: Notification) { log("TV \((n.object as! NSTextView).string.replacingOccurrences(of: "\n", with: "|"))") }
  func windowDidBecomeKey(_ n: Notification) { log("BECAME KEY") }
  func applicationDidBecomeActive(_ n: Notification) { log("DID BECOME ACTIVE") }
}
let app = App.shared; let d = Del(); app.delegate = d; app.run()
