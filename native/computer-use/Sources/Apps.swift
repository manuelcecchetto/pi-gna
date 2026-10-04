import AppKit
import ApplicationServices

// App inventory, name resolution, background launch, and the hard denylist (docs/COMPUTER_USE.md, "Policy").

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

let deniedBundleIds: Set<String> = [
    "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "com.github.wez.wezterm",
    "net.kovidgoyal.kitty", "org.alacritty", "io.alacritty", "dev.warp.Warp-Stable", "dev.warp.Warp",
    "io.github.manuelcecchetto.pigna", "io.github.manuelcecchetto.pigna.dev",
    "io.github.manuelcecchetto.pigna.computeruse",
    "com.apple.SecurityAgent", "com.apple.coreauthd", "com.apple.UserNotificationCenter",
    "com.apple.CoreServicesUIAgent", "com.apple.keychainaccess", "com.apple.ScreenSharing",
    "com.apple.loginwindow",
]

func isDeniedBundle(_ id: String) -> Bool { deniedBundleIds.contains(id) }

func deniedError(_ name: String) -> RPCError {
    RPCError(.deniedApp, "\(name) can never be controlled by computer use (terminal apps, pi-gna and macOS security prompts are off limits).")
}

struct InstalledApp { var bundleId: String; var name: String; var url: URL }

private func installedApps() -> [InstalledApp] {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let roots = ["/Applications", "/System/Applications", "\(home)/Applications"]
    var out: [InstalledApp] = []
    var seen = Set<String>()
    func scan(_ dir: String, depth: Int) {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        for n in names.sorted() {
            let path = "\(dir)/\(n)"
            if n.hasSuffix(".app") {
                guard let b = Bundle(path: path), let id = b.bundleIdentifier, seen.insert(id).inserted else { continue }
                let name = (b.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (b.object(forInfoDictionaryKey: "CFBundleName") as? String)
                    ?? String(n.dropLast(4))
                out.append(InstalledApp(bundleId: id, name: name, url: URL(fileURLWithPath: path)))
            } else if depth < 1, !n.hasPrefix(".") {
                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue { scan(path, depth: depth + 1) }
            }
        }
    }
    for r in roots { scan(r, depth: 0) }
    return out
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
    return v as? String
}

func axWindows(of pid: pid_t) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v) == .success else { return [] }
    return (v as? [AXUIElement]) ?? []
}

func windowId(_ el: AXUIElement) -> Int? {
    var id: CGWindowID = 0
    return _AXUIElementGetWindow(el, &id) == .success && id != 0 ? Int(id) : nil
}

private func windowList(pid: pid_t) -> [JSON] {
    if AXIsProcessTrusted() {
        return axWindows(of: pid).compactMap { w in
            guard let id = windowId(w) else { return nil }
            return ["id": id, "title": axString(w, kAXTitleAttribute) ?? ""]
        }
    }
    let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [JSON]) ?? []
    return info.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 }
        .map { ["id": $0[kCGWindowNumber as String] ?? 0, "title": $0[kCGWindowName as String] as? String ?? ""] }
}

func runningApp(bundleId: String) -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first { !$0.isTerminated }
}

/// Resolves a display name, bundle id or .app path; launches in the background when not running.
func resolveApp(_ query: String, launch: Bool = true) throws -> (bundleId: String, name: String, pid: pid_t) {
    let q = query.trimmingCharacters(in: .whitespaces)
    if q.isEmpty { throw RPCError(.invalidParams, "app is required") }
    let lower = q.lowercased()
    let running = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated && $0.bundleIdentifier != nil }

    var bundleId: String?
    var url: URL?
    var name = q
    if q.hasSuffix(".app"), let b = Bundle(path: q), let id = b.bundleIdentifier {
        bundleId = id; url = b.bundleURL
    } else if let r = running.first(where: { $0.bundleIdentifier!.lowercased() == lower })
        ?? running.first(where: { $0.activationPolicy == .regular && $0.localizedName?.lowercased() == lower }) {
        bundleId = r.bundleIdentifier; name = r.localizedName ?? q
    } else {
        let apps = installedApps()
        if let a = apps.first(where: { $0.bundleId.lowercased() == lower })
            ?? apps.first(where: { $0.name.lowercased() == lower })
            ?? apps.first(where: { $0.url.deletingPathExtension().lastPathComponent.lowercased() == lower }) {
            bundleId = a.bundleId; url = a.url; name = a.name
        }
    }
    guard let id = bundleId else { throw RPCError(.appNotFound, "No app named \"\(q)\" is running or installed. Call list_apps to see what is available.") }
    if isDeniedBundle(id) { throw deniedError(name) }
    if let r = runningApp(bundleId: id) { return (id, r.localizedName ?? name, r.processIdentifier) }
    guard launch else { throw RPCError(.appNotFound, "\(name) is not running.") }
    guard let appURL = url ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else {
        throw RPCError(.appNotFound, "Could not find \(name) to launch.")
    }
    return try launchInBackground(appURL, bundleId: id, name: name)
}

private func launchInBackground(_ url: URL, bundleId: String, name: String) throws -> (String, String, pid_t) {
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = false
    cfg.addsToRecentItems = false
    let sem = DispatchSemaphore(value: 0)
    var launched: NSRunningApplication?
    var failure: Error?
    NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, err in
        launched = app; failure = err; sem.signal()
    }
    if sem.wait(timeout: .now() + 15) == .timedOut { throw RPCError(.timeout, "Launching \(name) timed out.") }
    guard let app = launched else {
        throw RPCError(.appNotFound, "Launching \(name) failed: \(failure?.localizedDescription ?? "unknown error")")
    }
    // Wait for the first window so the following state read has something to show.
    if AXIsProcessTrusted() {
        for _ in 0..<50 {
            if !axWindows(of: app.processIdentifier).isEmpty { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
    }
    return (bundleId, app.localizedName ?? name, app.processIdentifier)
}

func registerAppMethods() {
    methods["list_apps"] = { _ in
        var apps: [JSON] = []
        var seen = Set<String>()
        let running = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && !$0.isTerminated && $0.bundleIdentifier != nil
        }
        for r in running {
            let id = r.bundleIdentifier!
            if isDeniedBundle(id) || !seen.insert(id).inserted { continue }
            apps.append(["id": id, "bundleId": id, "displayName": r.localizedName ?? id, "isRunning": true,
                         "pid": Int(r.processIdentifier), "windows": windowList(pid: r.processIdentifier)])
        }
        for a in installedApps() where !isDeniedBundle(a.bundleId) && seen.insert(a.bundleId).inserted {
            apps.append(["id": a.bundleId, "bundleId": a.bundleId, "displayName": a.name, "isRunning": false, "windows": [JSON]()])
        }
        return ["apps": apps]
    }

    methods["resolve_app"] = { params in
        guard let q = params["app"] as? String else { throw RPCError(.invalidParams, "app (name, bundle id or path) is required") }
        let r = try resolveApp(q, launch: params["launch"] as? Bool ?? true)
        return ["bundleId": r.bundleId, "displayName": r.name, "pid": Int(r.pid)]
    }
}
