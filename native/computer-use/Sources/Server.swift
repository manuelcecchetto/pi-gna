import Foundation

/// Single-client newline-delimited JSON-RPC 2.0 server on a Unix domain socket.
/// The first message must be `hello` with the launch token; anything else closes the connection.
final class Server {
    let path: String
    let token: String
    private var listenFd: Int32 = -1

    init(path: String, token: String) {
        self.path = path
        self.token = token
    }

    func start() throws {
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw posixError("socket") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            throw RPCError(rawCode: -1, "socket path too long")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            for (i, b) in bytes.enumerated() { buf[i] = b }
            buf[bytes.count] = 0
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        guard bound == 0 else { throw posixError("bind") }
        chmod(path, 0o600)
        guard listen(fd, 1) == 0 else { throw posixError("listen") }
        listenFd = fd
        Thread.detachNewThread { [self] in acceptLoop() }
    }

    private func posixError(_ what: String) -> RPCError {
        RPCError(rawCode: -1, "\(what): \(String(cString: strerror(errno)))")
    }

    /// One client at a time. When the authenticated client goes away the helper is done and exits.
    private func acceptLoop() {
        while true {
            let client = accept(listenFd, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                shutdownHelper()
            }
            if serve(client) { shutdownHelper() }
            close(client)
        }
    }

    /// Returns true when an authenticated client disconnected (helper should exit).
    private func serve(_ fd: Int32) -> Bool {
        var buffer = Data()
        var authed = false
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return authed }
            buffer.append(chunk, count: n)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                if line.isEmpty { continue }
                let (reply, ok) = handle(line, authed: authed)
                if !authed && !ok { send(fd, reply); return false }
                if ok { authed = true }
                if let reply { send(fd, reply) }
                if (reply?["_shutdown"] as? Bool) == true { return true }
            }
        }
    }

    private func handle(_ line: Data, authed: Bool) -> (JSON?, Bool) {
        guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? JSON,
              let method = obj["method"] as? String else {
            return (errorReply(nil, RPCError(rawCode: -32700, "parse error")), false)
        }
        let id = obj["id"]
        let params = obj["params"] as? JSON ?? [:]
        if !authed {
            let given = (method == "hello" ? params["token"] as? String : nil) ?? ""
            guard constantTimeEqual(given, token) else {
                return (errorReply(id, RPCError(rawCode: -32600, "unauthorized")), false)
            }
            return (resultReply(id, [
                "helperVersion": helperVersion, "protocol": protocolVersion,
                "os": ProcessInfo.processInfo.operatingSystemVersionString,
                "arch": machineArch(), "pid": Int(getpid()),
                "permissions": permissionStatus(),
            ]), true)
        }
        if method == "hello" { return (resultReply(id, ["protocol": protocolVersion]), true) }
        if method == "shutdown" {
            var r = resultReply(id, [:]) ?? [:]
            r["_shutdown"] = true
            return (r, true)
        }
        guard let handler = methods[method] else {
            return (errorReply(id, RPCError(rawCode: -32601, "method not found: \(method)")), true)
        }
        do { return (resultReply(id, try handler(params)), true) } catch let e as RPCError {
            return (errorReply(id, e), true)
        } catch {
            return (errorReply(id, RPCError(.actionFailed, "\(error)")), true)
        }
    }

    private func resultReply(_ id: Any?, _ result: JSON) -> JSON? {
        guard let id else { return nil }
        return ["jsonrpc": "2.0", "id": id, "result": result]
    }

    private func errorReply(_ id: Any?, _ e: RPCError) -> JSON? {
        ["jsonrpc": "2.0", "id": id ?? NSNull(), "error": e.json]
    }

    private func send(_ fd: Int32, _ message: JSON?) {
        guard var message else { return }
        message.removeValue(forKey: "_shutdown")
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(0x0A)
        data.withUnsafeBytes { raw in
            var off = 0
            while off < raw.count {
                let w = write(fd, raw.baseAddress! + off, raw.count - off)
                if w < 0 && errno == EINTR { continue }
                if w <= 0 { return }
                off += w
            }
        }
    }
}

private func constantTimeEqual(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    var diff = x.count ^ y.count
    for i in 0..<max(x.count, y.count) {
        diff |= Int((i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0))
    }
    return diff == 0
}

private func machineArch() -> String {
    #if arch(arm64)
    return "arm64"
    #else
    return "x86_64"
    #endif
}
