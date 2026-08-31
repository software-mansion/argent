import Network
import XCTest

/// The Argent on-device automation server, hosted inside an XCUITest.
///
/// XCUITest is the only Apple-supported way to drive arbitrary apps on a
/// physical iOS device, so this "test" starts an HTTP command server and
/// stays in a long wait instead of running one scripted scenario.
///
/// Layering: RunnerHTTPServer (framing) → dispatch here (decode, journal,
/// duplicate-send coalescing, busy gate) → command extensions (XCTest work).
final class ArgentRunnerSession: XCTestCase {
    /// Uptime anchor for the health payload, captured when the session
    /// instance is created.
    private let launchedAt = Date()

    let gate = MainThreadGate()
    private let journal = CommandJournal()
    /// Commands execute here one at a time, in arrival order. `status` never
    /// enters this queue, so health checks and lost-reply recovery stay
    /// responsive while a command runs.
    private let executionQueue = DispatchQueue(label: "argent.runner.execution")

    private let finishLock = NSLock()
    private var done: XCTestExpectation?

    /// Duplicate transport sends of one commandId (a client retry racing a slow
    /// execution) attach to the in-flight execution and share its reply instead
    /// of executing twice.
    private let inFlightLock = NSLock()
    private var inFlightReplies: [String: [(RunnerHTTPServer.Reply) -> Void]] =
        [:]

    private let suppressedIssuesLock = NSLock()
    private var suppressedIssueCount = 0

    /// Keeps the session alive after a recorded failure.
    override func setUp() {
        continueAfterFailure = true
    }

    // MARK: - Issue filtering

    /// The suppression matchers, verbatim. XCTIssue exposes no stable code for
    /// these shapes, so classification substring-matches Apple-owned wording in
    /// `compactDescription`. PROTOCOL.md's `status` section pins these exact
    /// strings as part of the contract.
    enum SuppressedIssueWording {
        /// Every suppression candidate must contain this snapshot-fetch wording.
        static let gate = "Failed to get matching snapshot"
        /// Marks a genuinely hung query. Issues containing it stay recorded.
        static let keepRecorded = "Timed out while evaluating UI query"
        /// Pure accessibility noise: an AX server error, and the variant a stale
        /// element produces after the UI it referenced moved on.
        static let noise = ["kAXError", "No matches found for"]
    }

    /// Whether an issue description is known accessibility noise that should be
    /// muted rather than recorded. XCTest tears the test down once recorded
    /// issues accumulate, and the server has to survive long sessions.
    static func isSuppressedAccessibilityIssue(_ description: String) -> Bool {
        guard description.contains(SuppressedIssueWording.gate) else {
            return false
        }

        // A hung UI query must stay recorded so the recorded-failure check keeps
        // seeing it.
        if description.contains(SuppressedIssueWording.keepRecorded) {
            return false
        }

        return SuppressedIssueWording.noise.contains {
            description.contains($0)
        }
    }

    /// Intercepts every XCTest issue, counting and muting known accessibility
    /// noise and recording the rest.
    override func record(_ issue: XCTIssue) {
        let description = issue.compactDescription

        if Self.isSuppressedAccessibilityIssue(description) {
            suppressedIssuesLock.lock()
            suppressedIssueCount += 1
            let count = suppressedIssueCount
            suppressedIssuesLock.unlock()

            NSLog(
                "ARGENT_RUNNER_AX_ISSUE_SUPPRESSED count=%ld description=%@",
                count,
                description
            )

            return
        }

        super.record(issue)
    }

    // MARK: - Entry point

    /// The session entry point: starts the HTTP command server and parks
    /// until a shutdown command or a listener failure ends the session.
    @MainActor
    func testServeCommands() throws {
        let port = Self.configuredPort()
        NSLog("ARGENT_RUNNER_STARTING requestedPort=%d", Int(port))

        let done = expectation(description: "argent runner shutdown")
        finishLock.lock()
        self.done = done
        finishLock.unlock()

        let server = RunnerHTTPServer(
            dispatch: { [weak self] body, deliver in
                self?.dispatch(body: body, deliver: deliver)
            },
            onFinish: { [weak self] in self?.finish() }
        )

        try server.start(port: port)
        NSLog("ARGENT_RUNNER_SERVING")

        // The wait pumps the main run loop, so command handlers can hop onto the
        // main thread while Network.framework serves connections on background
        // queues. Every XCTest UI call must run on the main thread.
        let outcome = XCTWaiter.wait(for: [done], timeout: 24 * 60 * 60)
        NSLog("ARGENT_RUNNER_STOPPED outcome=%@", String(describing: outcome))
        server.stop()

        if outcome != .completed {
            XCTFail(
                "runner session ended without a shutdown command (\(outcome))"
            )
        }
    }

    /// The port requested through the environment, forwarded by xcodebuild
    /// from TEST_RUNNER_ARGENT_RUNNER_PORT with the prefix stripped. Returning
    /// 0 lets the system pick one when the session runs directly from Xcode.
    static func configuredPort() -> UInt16 {
        if let raw = ProcessInfo.processInfo.environment["ARGENT_RUNNER_PORT"],
            let port = UInt16(raw)
        {
            return port
        }

        return 0
    }

    /// Ends the session wait, fulfilling the shutdown expectation exactly
    /// once. Reached from the shutdown reply and from a listener failure.
    private func finish() {
        finishLock.lock()
        let expectation = done
        done = nil
        finishLock.unlock()

        expectation?.fulfill()
    }

    // MARK: - Dispatch (transport queue)

    /// Routes one request body from the HTTP server: answers `status` inline,
    /// coalesces duplicate sends, and queues every other command for serial
    /// execution.
    private func dispatch(
        body: Data,
        deliver: @escaping (RunnerHTTPServer.Reply) -> Void
    ) {
        let request: CommandRequest

        do {
            request = try JSONDecoder().decode(CommandRequest.self, from: body)
        } catch {
            deliver(
                Self.encodeReply(
                    status: 400,
                    envelope: .failure(
                        .invalidRequest,
                        "unrecognized command payload: \(error)",
                        hint:
                            "Check the command name and fields against PROTOCOL.md."
                    )
                )
            )
            return
        }

        // Status is answered inline on the transport queue so it keeps answering
        // while the execution queue is busy.
        if request.command == .status {
            deliver(
                Self.encodeReply(
                    status: 200,
                    envelope: statusEnvelope(for: request)
                )
            )
            return
        }

        if attachToInFlight(request, deliver: deliver) {
            return
        }

        NSLog(
            "ARGENT_RUNNER_COMMAND_ACCEPTED command=%@ commandId=%@",
            request.command.rawValue,
            request.normalizedCommandId ?? ""
        )

        journal.accept(request)

        executionQueue.async {
            self.journal.started(request)

            let envelope = self.executeGated(request)
            let reply = Self.encodeReply(
                status: envelope.ok ? 200 : 500,
                envelope: envelope,
                finishAfterSend: request.command == .shutdown && envelope.ok
            )

            self.journal.finished(
                request,
                envelope: envelope,
                encodedEnvelope: reply.body
            )

            NSLog(
                "ARGENT_RUNNER_COMMAND_FINISHED command=%@ commandId=%@ ok=%d",
                request.command.rawValue,
                request.normalizedCommandId ?? "",
                envelope.ok ? 1 : 0
            )

            self.deliverReleasingInFlight(
                request,
                reply: reply,
                deliver: deliver
            )
        }
    }

    /// Builds the `status` reply: a journal lookup when `statusCommandId` is
    /// present, otherwise the runner health payload.
    private func statusEnvelope(for request: CommandRequest) -> Envelope {
        if let id = request.statusCommandId?.trimmingCharacters(
            in: .whitespacesAndNewlines
        ),
            !id.isEmpty
        {
            return .success(journal.status(commandId: id))
        }

        let state: String

        switch gate.availability() {
        case .idle: state = "idle"
        case .busy: state = "busy"
        case .wedged: state = "wedged"
        }

        return .success(
            HealthPayload(
                uptimeMs: Date().timeIntervalSince(launchedAt) * 1000,
                state: state,
                suppressedIssues: currentSuppressedIssueCount(),
                // Status must answer while a command runs, so testRun is read off the
                // main thread. That is acceptable for an informational counter.
                recordedFailures: testRun?.totalFailureCount ?? 0
            )
        )
    }

    /// The number of issues muted so far. Feeds the health payload, and
    /// `performOnMain` reads it before and after each command to surface a
    /// suppression delta as an envelope warning.
    func currentSuppressedIssueCount() -> Int {
        suppressedIssuesLock.lock()
        defer { suppressedIssuesLock.unlock() }
        return suppressedIssueCount
    }

    /// Returns true after attaching a duplicate send to the execution already
    /// running under the same commandId, otherwise marks the id as in flight.
    private func attachToInFlight(
        _ request: CommandRequest,
        deliver: @escaping (RunnerHTTPServer.Reply) -> Void
    ) -> Bool {
        guard let id = request.normalizedCommandId else { return false }

        inFlightLock.lock()
        defer { inFlightLock.unlock() }

        if inFlightReplies[id] != nil {
            inFlightReplies[id]?.append(deliver)
            NSLog("ARGENT_RUNNER_DUPLICATE_SEND_COALESCED commandId=%@", id)
            return true
        }

        inFlightReplies[id] = []

        return false
    }

    /// Delivers the reply to the original sender and to every duplicate send
    /// that attached while the command ran.
    private func deliverReleasingInFlight(
        _ request: CommandRequest,
        reply: RunnerHTTPServer.Reply,
        deliver: (RunnerHTTPServer.Reply) -> Void
    ) {
        var waiters: [(RunnerHTTPServer.Reply) -> Void] = []

        if let id = request.normalizedCommandId {
            inFlightLock.lock()
            waiters = inFlightReplies.removeValue(forKey: id) ?? []
            inFlightLock.unlock()
        }

        deliver(reply)

        for waiter in waiters {
            waiter(reply)
        }
    }

    // MARK: - Execution (serial queue → main thread)

    /// Runs the command on the main thread under its watchdog budget. Refuses
    /// immediately while the main thread is still occupied by abandoned work.
    private func executeGated(_ request: CommandRequest) -> Envelope {
        switch gate.availability() {
        case .busy(let seconds):
            NSLog(
                "ARGENT_RUNNER_BUSY command=%@ abandonedFor=%.1f",
                request.command.rawValue,
                seconds
            )
            return .failure(
                .runnerBusy,
                "The runner is still finishing a previous command that overran its watchdog "
                    + "(usually an accessibility capture on a heavy or animating screen).",
                hint:
                    "Wait a few seconds and retry; if snapshots keep failing on this screen, use "
                    + "screenshot as visual truth and interact by coordinates."
            )
        case .wedged(let seconds):
            NSLog("ARGENT_RUNNER_WEDGED abandonedFor=%.1f", seconds)
            return .failure(
                .runnerWedged,
                "The runner's main thread has been stuck in abandoned work for \(Int(seconds))s "
                    + "and cannot recover on its own.",
                hint: "Restart the runner session, then retry the command."
            )
        case .idle:
            break
        }

        do {
            return try gate.run(timeout: request.command.executionTimeout) {
                self.performOnMain(request)
            }
        } catch MainThreadGate.Failure.timedOut {
            return .failure(
                .commandTimedOut,
                "\(request.command.rawValue) exceeded its \(Int(request.command.executionTimeout))s "
                    + "main-thread budget; the work was abandoned and may still complete on the device.",
                hint:
                    "Retry after a few seconds; the runner reports busy until the abandoned work drains."
            )
        } catch {
            return .failure(.commandFailed, String(describing: error))
        }
    }

    /// Encodes an envelope into the HTTP reply handed to the transport layer.
    static func encodeReply(
        status: Int,
        envelope: Envelope,
        finishAfterSend: Bool = false
    ) -> RunnerHTTPServer.Reply {
        let body =
            (try? JSONEncoder().encode(envelope))
            ?? Data(
                #"{"ok":false,"error":{"code":"COMMAND_FAILED","message":"response encoding failed"}}"#
                    .utf8
            )
        return RunnerHTTPServer.Reply(
            status: status,
            body: body,
            finishAfterSend: finishAfterSend
        )
    }
}
