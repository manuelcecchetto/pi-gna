import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit

// Background window screenshots (docs/COMPUTER_USE.md, "Screenshot"). Capture is per window via
// SCContentFilter(desktopIndependentWindow:), so occluded windows are captured without what covers them.

let maxScreenshotWidth = 1600.0
let maxTransientRegions = 4

/// Mapping of the last screenshot per app, used by coordinate actions (T05): screen = frame.origin + point / scale.
struct CaptureMapping {
    var windowId: Int
    var frame: CGRect      // window frame in global top-left screen points
    var scale: Double      // screenshot pixels per window point (<= 1)
}
var captureMappings: [String: CaptureMapping] = [:]
let captureLock = NSLock()

/// Converts a point in screenshot space (window-relative) to a global screen point.
func screenPoint(bundleId: String, x: Double, y: Double) -> CGPoint? {
    captureLock.lock(); defer { captureLock.unlock() }
    guard let m = captureMappings[bundleId] else { return nil }
    return CGPoint(x: m.frame.minX + x / m.scale, y: m.frame.minY + y / m.scale)
}

private func screenRecordingError() -> RPCError {
    RPCError(.permissionDenied, "Screen Recording permission is not granted to pi-gna Computer Use. Grant it in System Settings > Privacy & Security > Screen Recording.",
             data: ["missing": ["screenRecording"]])
}

private func shareableWindows() throws -> [SCWindow] {
    let sem = DispatchSemaphore(value: 0)
    var content: SCShareableContent?
    var failure: Error?
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { c, e in content = c; failure = e; sem.signal() }
    if sem.wait(timeout: .now() + 10) == .timedOut { throw RPCError(.timeout, "Listing windows timed out.") }
    guard let content else {
        // A denied grant surfaces as an error here; never fall back to a black image.
        throw failure.map { _ in screenRecordingError() } ?? RPCError(.actionFailed, "Could not list windows.")
    }
    return content.windows
}

private func captureImage(_ w: SCWindow, width: Int, height: Int) throws -> CGImage {
    let cfg = SCStreamConfiguration()
    cfg.width = max(width, 1)
    cfg.height = max(height, 1)
    cfg.showsCursor = false
    cfg.scalesToFit = true
    let filter = SCContentFilter(desktopIndependentWindow: w)
    let sem = DispatchSemaphore(value: 0)
    var image: CGImage?
    var failure: Error?
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { i, e in image = i; failure = e; sem.signal() }
    if sem.wait(timeout: .now() + 10) == .timedOut { throw RPCError(.timeout, "Window capture timed out.") }
    guard let image else {
        throw RPCError(.actionFailed, "Window capture failed: \(failure?.localizedDescription ?? "unknown error")")
    }
    return image
}

private func jpegBase64(_ image: CGImage) throws -> String {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
        throw RPCError(.actionFailed, "JPEG encoding failed.")
    }
    return data.base64EncodedString()
}

/// Captures the target window plus transient same-pid windows above it. `windowId` nil picks the AX focused/main window,
/// else the largest on-screen layer-0 window of the pid.
func captureWindow(bundleId: String, pid: pid_t, windowId wanted: Int?, preferredWindowId: Int?) throws -> JSON {
    guard CGPreflightScreenCaptureAccess() else { throw screenRecordingError() }
    let wins = try shareableWindows().filter { $0.owningApplication?.processID == pid }
    let id = wanted ?? preferredWindowId
    let main: SCWindow
    if let id {
        guard let w = wins.first(where: { Int($0.windowID) == id }) else {
            throw RPCError(.windowNotFound, "Window \(id) was not found. Call list_apps for current window ids.")
        }
        main = w
    } else {
        let candidates = wins.filter { $0.windowLayer == 0 && $0.isOnScreen && $0.frame.width > 1 && $0.frame.height > 1 }
        guard let w = candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            throw RPCError(.windowNotFound, "The app has no visible window (minimized or on another Space).")
        }
        main = w
    }
    let frame = main.frame
    let scale = min(1.0, maxScreenshotWidth / max(frame.width, 1))
    func render(_ w: SCWindow) throws -> (String, Int, Int) {
        let pw = Int((w.frame.width * scale).rounded()), ph = Int((w.frame.height * scale).rounded())
        let img = try captureImage(w, width: pw, height: ph)
        return (try jpegBase64(img), img.width, img.height)
    }
    let (jpeg, width, height) = try render(main)

    // Menus, popovers and similar transient windows (layer > 0) over the main window, as separate regions.
    let overlays = wins.filter {
        Int($0.windowID) != Int(main.windowID) && $0.isOnScreen && $0.windowLayer > main.windowLayer
            && $0.frame.width > 1 && $0.frame.height > 1 && $0.frame.intersects(frame)
    }.sorted { ($0.windowLayer, $0.windowID) < ($1.windowLayer, $1.windowID) }.prefix(maxTransientRegions)
    var regions: [JSON] = [[
        "windowId": Int(main.windowID), "zIndex": 0, "jpeg": jpeg, "width": width, "height": height,
        "x": 0, "y": 0, "screenOrigin": ["x": frame.minX, "y": frame.minY],
    ]]
    for (i, w) in overlays.enumerated() {
        guard let (j, rw, rh) = try? render(w) else { continue }
        regions.append([
            "windowId": Int(w.windowID), "zIndex": i + 1, "jpeg": j, "width": rw, "height": rh,
            "x": Int(((w.frame.minX - frame.minX) * scale).rounded()), "y": Int(((w.frame.minY - frame.minY) * scale).rounded()),
            "screenOrigin": ["x": w.frame.minX, "y": w.frame.minY],
        ])
    }

    captureLock.lock()
    captureMappings[bundleId] = CaptureMapping(windowId: Int(main.windowID), frame: frame, scale: scale)
    captureLock.unlock()
    return [
        "jpeg": jpeg, "mimeType": "image/jpeg", "width": width, "height": height,
        "logicalWidth": Int(frame.width.rounded()), "logicalHeight": Int(frame.height.rounded()), "scale": scale,
        "windowId": Int(main.windowID),
        "windowFrame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
        "regions": regions,
    ]
}

func registerCaptureMethods() {
    methods["screenshot"] = { params in
        guard CGPreflightScreenCaptureAccess() else { throw screenRecordingError() }
        let target = try targetApp(params)
        return try captureWindow(bundleId: target.bundleId, pid: target.pid,
                                 windowId: (params["window_id"] as? NSNumber)?.intValue, preferredWindowId: nil)
    }
}
