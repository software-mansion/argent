import Foundation

let token = String(repeating: "a", count: 64)
let body = Data(#"{"command":"status"}"#.utf8)
func request(_ headers: [String], _ payload: Data = body) -> Data {
    var data = Data((["POST /command HTTP/1.1", "Content-Length: \(body.count)"]
        + headers + ["", ""]).joined(separator: "\r\n").utf8)
    data.append(payload)
    return data
}
func verdict(_ data: Data) -> RunnerHTTPServer.RequestVerdict {
    RunnerHTTPServer.requestVerdict(in: data, authorizationToken: token)
}
let authorized = ["Authorization: Bearer \(token)"]
assert(verdict(request(authorized)) == .complete(body))
assert(verdict(request(["authorization: Bearer \(token)"])) == .complete(body))
assert(verdict(request([])) == .unauthorized)
assert(verdict(request(["Authorization: Bearer \(String(repeating: "b", count: 64))"])) == .unauthorized)
assert(verdict(request(authorized + authorized)) == .unauthorized)
assert(verdict(request(authorized, Data(body.prefix(3)))) == .incomplete)
assert(verdict(Data("POST /command HTTP/1.1\r\nAuth".utf8)) == .incomplete)
assert(RunnerHTTPServer.requestVerdict(in: request([])) == .complete(body))
assert(verdict(Data("POST /command HTTP/1.1\r\nAuthorization: Bearer \(token)\r\n\r\n".utf8)) == .malformed)
for address in ["::1", "fe80::1", "2001:db8::1", "0.0.0.0"] {
    let server = RunnerHTTPServer(tunnelAddress: address, dispatch: { _, _ in }, onFinish: {}, onListenerFailure: { _ in })
    do {
        try server.start(port: 0)
        fatalError("Accepted non-tunnel address \(address)")
    } catch { }
}
print("Runner HTTP authorization and request framing passed")
