import Foundation

/// Records the fate of every identified command. A client whose reply was
/// lost in transit asks what happened via `status` + `statusCommandId`
/// instead of replaying a mutation that may already have run.
final class CommandJournal {
    enum State: String {
        case notAccepted
        case accepted
        case started
        case completed
        case failed
    }

    private struct Entry {
        let commandId: String
        let command: CommandKind
        var state: State
        var responseOk: Bool? = nil
        var responseJson: String? = nil
        var errorCode: String? = nil
        var errorMessage: String? = nil
        var errorHint: String? = nil
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    /// Enough to cover any plausible in-flight window. Recovery asks about
    /// the command that just failed.
    private let maxEntries = 64
    private let maxRetainedResponseBytes = 16 * 1024

    /// Records an identified command as accepted, before it is queued.
    func accept(_ request: CommandRequest) {
        guard let id = request.normalizedCommandId else { return }

        lock.lock()
        defer { lock.unlock() }

        entries[id] = Entry(
            commandId: id,
            command: request.command,
            state: .accepted
        )

        touch(id)
    }

    /// Marks the command as started on the execution queue.
    func started(_ request: CommandRequest) {
        guard let id = request.normalizedCommandId else { return }

        lock.lock()
        defer { lock.unlock() }

        entries[id]?.state = .started
    }

    /// Records the command's outcome, retaining the encoded reply when the
    /// command qualifies and the reply is small enough.
    func finished(
        _ request: CommandRequest,
        envelope: Envelope,
        encodedEnvelope: Data
    ) {
        guard let id = request.normalizedCommandId else { return }

        lock.lock()
        defer { lock.unlock() }

        var entry =
            entries[id]
            ?? Entry(commandId: id, command: request.command, state: .accepted)

        entry.state = envelope.ok ? .completed : .failed
        entry.responseOk = envelope.ok
        entry.responseJson =
            request.command.retainsResponseInJournal
                && encodedEnvelope.count <= maxRetainedResponseBytes
            ? String(data: encodedEnvelope, encoding: .utf8)
            : nil
        entry.errorCode = envelope.error?.code
        entry.errorMessage = envelope.error?.message
        entry.errorHint = envelope.error?.hint

        entries[id] = entry
        touch(id)
    }

    /// The journaled fate of one commandId, `notAccepted` when the id is
    /// unknown or was evicted.
    func status(commandId: String) -> CommandStatusPayload {
        let trimmed = commandId.trimmingCharacters(in: .whitespacesAndNewlines)

        lock.lock()
        let entry = entries[trimmed]
        lock.unlock()

        guard let entry else {
            return CommandStatusPayload(
                commandId: trimmed,
                state: State.notAccepted.rawValue,
                command: nil,
                responseOk: nil,
                responseJson: nil,
                errorCode: nil,
                errorMessage: nil,
                errorHint: nil
            )
        }

        return CommandStatusPayload(
            commandId: entry.commandId,
            state: entry.state.rawValue,
            command: entry.command.rawValue,
            responseOk: entry.responseOk,
            responseJson: entry.responseJson,
            errorCode: entry.errorCode,
            errorMessage: entry.errorMessage,
            errorHint: entry.errorHint
        )
    }

    /// Callers hold `lock`.
    private func touch(_ id: String) {
        order.removeAll { $0 == id }
        order.append(id)

        while order.count > maxEntries {
            entries.removeValue(forKey: order.removeFirst())
        }
    }
}
