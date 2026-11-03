import Foundation

let body = Data(#"{"command":"status"}"#.utf8)
func request(_ payload: Data = body) -> Data {
    var data = Data([
        "POST /command HTTP/1.1", "Content-Length: \(body.count)", "", ""
    ].joined(separator: "\r\n").utf8)
    data.append(payload)
    return data
}
assert(RunnerHTTPServer.requestVerdict(in: request()) == .complete(body))
assert(RunnerHTTPServer.requestVerdict(in: request(Data(body.prefix(3)))) == .incomplete)
assert(RunnerHTTPServer.requestVerdict(in: Data("POST /command HTTP/1.1\r\n".utf8)) == .incomplete)
assert(RunnerHTTPServer.requestVerdict(in: Data("POST /command HTTP/1.1\r\n\r\n".utf8)) == .malformed)
assert(RunnerHTTPServer.requestVerdict(in: Data("POST /command HTTP/1.1\r\nContent-Length: 2097153\r\n\r\n".utf8)) == .oversized)
for address in ["::1", "fe80::1", "2001:db8::1", "0.0.0.0"] {
    let server = RunnerHTTPServer(tunnelAddress: address, dispatch: { _, _ in }, onFinish: {}, onListenerFailure: { _ in })
    do {
        try server.start(port: 0)
        fatalError("Accepted non-tunnel address \(address)")
    } catch { }
}
print("Runner HTTP tunnel binding and request framing passed")
