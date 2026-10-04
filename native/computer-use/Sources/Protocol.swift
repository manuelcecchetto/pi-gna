import Foundation

/// Helper protocol version spoken on the socket and bumped only when the wire format changes.
let protocolVersion = 1
/// Bumped only when the helper's own behavior changes (see docs/COMPUTER_USE.md, "Install location").
let helperVersion = 2

typealias JSON = [String: Any]

/// JSON-RPC error codes, helper range -32000...-32099 (docs/COMPUTER_USE.md, "Errors").
enum RPCErrorCode: Int {
    case permissionDenied = -32001
    case appNotFound = -32002
    case windowNotFound = -32003
    case staleElement = -32004
    case actionFailed = -32005
    case cancelled = -32006
    case deniedApp = -32007
    case invalidParams = -32008
    case helperCrashed = -32009
    case timeout = -32010
    case backgroundUnsupported = -32011
}

struct RPCError: Error {
    var code: Int
    var message: String
    var data: JSON?

    init(_ code: RPCErrorCode, _ message: String, data: JSON? = nil) {
        self.code = code.rawValue
        self.message = message
        self.data = data
    }

    init(rawCode: Int, _ message: String) {
        self.code = rawCode
        self.message = message
    }

    var json: JSON {
        var e: JSON = ["code": code, "message": message]
        if let data { e["data"] = data }
        return e
    }
}

typealias Handler = (JSON) throws -> JSON

/// Method dispatch table. Later nodes add entries (list_apps, get_state, click, ...) by extending
/// `registerMethods` from their own file; keep handlers synchronous and return a JSON result object.
var methods: [String: Handler] = [:]

func registerMethods() {
    registerCoreMethods()
    registerAppMethods()
    registerAXMethods()
    registerCaptureMethods()
    registerInputMethods()
}
