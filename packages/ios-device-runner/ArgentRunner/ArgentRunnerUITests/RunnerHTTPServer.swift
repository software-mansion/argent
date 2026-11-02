import Foundation
import Network

/// Minimal single-purpose HTTP/1.1 endpoint on NWListener: each connection
/// carries one POSTed JSON command and receives one JSON reply, then closes.
///
/// USB uses a loopback listener. A CoreDevice connection binds only the
/// tunnel address and requires a per-launch bearer token. The paired Mac
/// reads that token from the runner's private container through devicectl.
final class RunnerHTTPServer {
    struct Reply {
        let status: Int
        let body: Data
        /// When set, the server invokes `onFinish` after this reply has been
        /// flushed. The shutdown acknowledgement must reach the client before
        /// the session ends.
        let finishAfterSend: Bool

        init(status: Int, body: Data, finishAfterSend: Bool = false) {
            self.status = status
            self.body = body
            self.finishAfterSend = finishAfterSend
        }
    }

    /// Upper bound on the size of one request. Each request carries a single
    /// command, so a larger body indicates a client bug.
    private static let maxRequestBytes = 2 * 1024 * 1024
    private let queue = DispatchQueue(label: "argent.runner.transport")
    private let dispatch: (Data, @escaping (Reply) -> Void) -> Void
    /// The clean end of the session, after a shutdown reply has been flushed.
    private let onFinish: () -> Void
    /// The listener can no longer accept connections (the port is in use, the
    /// interface is unavailable). Carries the failure description.
    private let onListenerFailure: (String) -> Void
    private var listener: NWListener?
    private let tunnelAddress: String?
    private var sessionToken: String?

    private static var sessionFile: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("argent-runner-session.json")
    }

    init(
        tunnelAddress: String? = nil,
        dispatch: @escaping (Data, @escaping (Reply) -> Void) -> Void,
        onFinish: @escaping () -> Void,
        onListenerFailure: @escaping (String) -> Void
    ) {
        self.tunnelAddress = tunnelAddress
        self.dispatch = dispatch
        self.onFinish = onFinish
        self.onListenerFailure = onListenerFailure
    }

    /// Starts listening on the selected interface, on the given port or a system-assigned
    /// one when the port is 0.
    func start(port: UInt16) throws {
        let parameters = NWParameters.tcp
        if let address = tunnelAddress {
            guard let ipv6 = IPv6Address(address),
                let prefix = ipv6.rawValue.first, prefix & 0xfe == 0xfc
            else {
                throw NSError(domain: "ArgentRunner", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Expected a CoreDevice tunnel IPv6 address"
                ])
            }
            // Bind the tunnel only, never Wi-Fi or a wildcard address.
            parameters.requiredLocalEndpoint = .hostPort(
                host: NWEndpoint.Host(address), port: NWEndpoint.Port(rawValue: port)!
            )
            sessionToken = (UUID().uuidString + UUID().uuidString)
                .replacingOccurrences(of: "-", with: "").lowercased()
            try? FileManager.default.removeItem(at: Self.sessionFile)
        } else {
            parameters.requiredInterfaceType = .loopback
        }
        let listener: NWListener

        if port > 0, let nwPort = NWEndpoint.Port(rawValue: port) {
            listener = try NWListener(using: parameters, on: nwPort)
        } else {
            listener = try NWListener(using: parameters)
        }

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                guard let self else { return }
                if let token = self.sessionToken {
                    do {
                        let data = try JSONSerialization.data(withJSONObject: [
                            "port": Int(self.listener?.port?.rawValue ?? 0), "token": token
                        ])
                        try data.write(to: Self.sessionFile, options: .atomic)
                        try FileManager.default.setAttributes(
                            [.posixPermissions: 0o600], ofItemAtPath: Self.sessionFile.path
                        )
                    } catch {
                        self.onListenerFailure("Could not publish runner session credentials")
                        self.stop()
                        return
                    }
                }
                NSLog(
                    "ARGENT_RUNNER_LISTENING port=%d",
                    Int(self.listener?.port?.rawValue ?? 0)
                )
            case .failed(let error):
                // A failed listener can never receive another command. Hand the
                // failure to the session so it ends as a failed test, and the
                // host observes a failing exit instead of a silent hang or a
                // green run that never served.
                let description = String(describing: error)
                NSLog("ARGENT_RUNNER_LISTENER_FAILED error=%@", description)
                self?.onListenerFailure(description)
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connection.start(queue: self.queue)
            self.receive(on: connection, buffered: Data())
        }

        self.listener = listener
        listener.start(queue: queue)
    }

    /// Stops accepting connections.
    func stop() {
        listener?.cancel()
        listener = nil
        if sessionToken != nil {
            try? FileManager.default.removeItem(at: Self.sessionFile)
        }
    }

    /// Accumulates bytes from one connection until the buffered request is
    /// complete, then dispatches its body.
    private func receive(on connection: NWConnection, buffered: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) {
            [weak self] data, _, _, _ in

            guard let self, let data, !data.isEmpty else {
                connection.cancel()
                return
            }

            var buffer = buffered
            buffer.append(data)

            if buffer.count > Self.maxRequestBytes {
                self.send(
                    Reply(
                        status: 413,
                        body: Self.oversizedRequestBody(
                            limit: Self.maxRequestBytes
                        )
                    ),
                    over: connection
                )
                return
            }

            switch Self.requestVerdict(in: buffer, authorizationToken: self.sessionToken) {
            case .complete(let body):
                self.dispatch(body) { reply in
                    self.send(reply, over: connection)
                }
            case .incomplete:
                self.receive(on: connection, buffered: buffer)
            case .malformed:
                self.send(
                    Reply(status: 400, body: Self.malformedRequestBody()),
                    over: connection
                )
            case .oversized:
                self.send(
                    Reply(
                        status: 413,
                        body: Self.oversizedRequestBody(
                            limit: Self.maxRequestBytes
                        )
                    ),
                    over: connection
                )
            case .unauthorized:
                self.send(
                    Reply(status: 401, body: Data(
                        #"{"ok":false,"error":{"code":"UNAUTHORIZED","message":"runner session token required"}}"#.utf8
                    )),
                    over: connection
                )
            }
        }
    }

    /// Writes the HTTP reply, closes the connection, and triggers `onFinish`
    /// for a reply marked `finishAfterSend`.
    private func send(_ reply: Reply, over connection: NWConnection) {
        let head = [
            "HTTP/1.1 \(reply.status) \(reply.status == 200 ? "OK" : "Error")",
            "Content-Type: application/json",
            "Content-Length: \(reply.body.count)",
            "Connection: close",
            "",
            "",
        ].joined(separator: "\r\n")

        var payload = Data(head.utf8)
        payload.append(reply.body)

        connection.send(
            content: payload,
            isComplete: true,
            completion: .contentProcessed { [weak self] error in
                if let error {
                    NSLog(
                        "ARGENT_RUNNER_SEND_FAILED error=%@",
                        String(describing: error)
                    )
                }

                connection.cancel()

                if reply.finishAfterSend {
                    self?.onFinish()
                }
            }
        )
    }

    /// Verdict on the bytes buffered so far for one request.
    enum RequestVerdict: Equatable {
        /// The header block or declared body has not fully arrived. Keep
        /// receiving.
        case incomplete
        /// A full request. The payload is the raw body bytes.
        case complete(Data)
        /// The header block ended without a usable Content-Length. Later bytes
        /// cannot repair a finished header block, so waiting for more would
        /// hang the connection.
        case malformed
        /// The declared Content-Length exceeds `maxRequestBytes`. The request
        /// is rejected before its body arrives.
        case oversized
        case unauthorized
    }

    /// Classifies the buffered bytes as an incomplete, complete, malformed,
    /// oversized, or unauthorized request.
    static func requestVerdict(in buffer: Data, authorizationToken: String? = nil) -> RequestVerdict {
        guard let headEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            return .incomplete
        }

        let head = String(
            decoding: buffer.subdata(
                in: buffer.startIndex..<headEnd.lowerBound
            ),
            as: UTF8.self
        )

        var contentLength: Int?
        var authorization: [String] = []

        for line in head.split(separator: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }

            if parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "authorization" {
                authorization.append(parts[1].trimmingCharacters(in: .whitespaces))
            }

            if parts[0].trimmingCharacters(in: .whitespaces).lowercased()
                == "content-length"
            {
                contentLength = Int(
                    parts[1].trimmingCharacters(in: .whitespaces)
                )
            }
        }

        if let authorizationToken {
            let expected = Array("Bearer \(authorizationToken)".utf8)
            let actual = Array((authorization.first ?? "").utf8)
            guard authorization.count == 1, actual.count == expected.count else {
                return .unauthorized
            }
            // Do not make token comparison depend on a matching prefix.
            let difference = zip(actual, expected).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) }
            guard difference == 0 else { return .unauthorized }
        }

        guard let contentLength, contentLength >= 0 else { return .malformed }
        guard contentLength <= maxRequestBytes else { return .oversized }

        let bodyStart = headEnd.upperBound

        guard
            buffer.distance(from: bodyStart, to: buffer.endIndex)
                >= contentLength
        else { return .incomplete }

        return .complete(
            buffer.subdata(
                in: bodyStart..<buffer.index(bodyStart, offsetBy: contentLength)
            )
        )
    }

    /// The INVALID_REQUEST body for a request that exceeds the size limit.
    private static func oversizedRequestBody(limit: Int) -> Data {
        Data(
            #"{"ok":false,"error":{"code":"INVALID_REQUEST","message":"request body exceeds \#(limit) bytes"}}"#
                .utf8
        )
    }

    /// The INVALID_REQUEST body for a header block without a usable
    /// Content-Length.
    private static func malformedRequestBody() -> Data {
        Data(
            #"{"ok":false,"error":{"code":"INVALID_REQUEST","message":"request headers lack a usable Content-Length"}}"#
                .utf8
        )
    }
}
