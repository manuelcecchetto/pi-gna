import AppKit
import ApplicationServices
import CoreGraphics

func permissionStatus() -> JSON {
    ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
}

func registerCoreMethods() {
    methods["ping"] = { _ in
        ["version": helperVersion, "protocol": protocolVersion, "pid": Int(getpid())]
    }

    methods["permissions"] = { params in
        // docs/DESIGN.md, "Computer Use": `permissions { prompt? }` is the status call; prompt triggers system prompts.
        if params["prompt"] as? Bool == true { return try requestPermissions(params) }
        return permissionStatus()
    }

    methods["request_permissions"] = requestPermissions

    methods["open_settings"] = { params in
        let pane = params["pane"] as? String ?? ""
        let url: String
        switch pane {
        case "accessibility":
            url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case "screen_recording":
            url = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        default:
            throw RPCError(.invalidParams, "pane must be \"accessibility\" or \"screen_recording\"")
        }
        guard let u = URL(string: url) else { throw RPCError(.invalidParams, "bad pane") }
        DispatchQueue.main.async { NSWorkspace.shared.open(u) }
        return [:]
    }
}

private func requestPermissions(_ params: JSON) throws -> JSON {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    _ = CGRequestScreenCaptureAccess()
    return permissionStatus()
}
