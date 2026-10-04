import AppKit

// Launched through LaunchServices: open -g -a <app> --args --socket <path> --token <hex> --parent <pid>

func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func shutdownHelper() -> Never {
    if let path = socketPath { unlink(path) }
    exit(0)
}

var signalSources: [DispatchSourceSignal] = []
var socketPath: String? = argument("--socket")

guard let path = socketPath, let token = argument("--token"), !token.isEmpty else {
    FileHandle.standardError.write(Data("usage: --socket <path> --token <hex> [--parent <pid>]\n".utf8))
    exit(64)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

registerMethods()
let server = Server(path: path, token: token)
do { try server.start() } catch {
    FileHandle.standardError.write(Data("computer-use: \(error)\n".utf8))
    exit(1)
}

if let parent = argument("--parent").flatMap({ pid_t($0) }) {
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
        if kill(parent, 0) != 0 && errno == ESRCH { shutdownHelper() }
    }
}

for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { shutdownHelper() }
    src.resume()
    signalSources.append(src)
}

app.run()
