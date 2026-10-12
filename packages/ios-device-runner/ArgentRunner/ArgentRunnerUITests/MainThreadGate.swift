import Foundation

/// Runs command work on the main thread under a per-command timeout and
/// tracks work the timeout abandoned. While abandoned work is still
/// running the gate reports `busy`, and past `wedgeThreshold` it reports
/// `wedged`. A `wedged` report tells the host to recycle the runner.
final class MainThreadGate {
    enum Availability {
        case idle
        case busy(abandonedForSeconds: TimeInterval)
        case wedged(abandonedForSeconds: TimeInterval)
    }

    enum Failure: Error {
        case timedOut
    }

    /// Lifecycle flags for one dispatched block. The lock guarantees that
    /// exactly one of `finished` and `abandoned` ends up set.
    private final class WorkState {
        var finished = false
        var abandoned = false
    }

    private let lock = NSLock()
    private var abandonedCount = 0
    private var abandonedSince: Date?
    private let wedgeThreshold: TimeInterval

    init(wedgeThreshold: TimeInterval = 120) {
        self.wedgeThreshold = wedgeThreshold
    }

    /// The gate's current view of the main thread: idle, busy, or wedged.
    func availability() -> Availability {
        lock.lock()
        defer { lock.unlock() }

        guard abandonedCount > 0 else { return .idle }
        let stuckFor = abandonedSince.map { Date().timeIntervalSince($0) } ?? 0

        return stuckFor > wedgeThreshold
            ? .wedged(abandonedForSeconds: stuckFor)
            : .busy(abandonedForSeconds: stuckFor)
    }

    /// Runs the work on the main thread, throwing `Failure.timedOut` after
    /// marking work that overran the budget as abandoned.
    func run<T>(timeout: TimeInterval, _ work: @escaping () throws -> T) throws
        -> T
    {
        if Thread.isMainThread {
            return try work()
        }

        let semaphore = DispatchSemaphore(value: 0)
        let state = WorkState()
        var result: Result<T, Error>?

        // The main run loop is pumped by the XCTWaiter in ArgentRunnerSession.
        DispatchQueue.main.async {
            do {
                result = .success(try work())
            } catch {
                result = .failure(error)
            }

            self.lock.lock()
            if state.abandoned {
                self.abandonedCount -= 1

                if self.abandonedCount == 0 {
                    self.abandonedSince = nil
                    NSLog("ARGENT_RUNNER_ABANDONED_WORK_DRAINED")
                }
            } else {
                state.finished = true
            }
            self.lock.unlock()

            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            lock.lock()
            if !state.finished {
                // The block cannot be cancelled and keeps running on the main
                // thread. Marking it abandoned makes availability() report busy
                // until it drains.
                state.abandoned = true
                abandonedCount += 1

                if abandonedSince == nil {
                    abandonedSince = Date()
                }
            }
            lock.unlock()

            throw Failure.timedOut
        }

        switch result {
        case .success(let value):
            return value
        case .failure(let error):
            throw error
        case .none:
            throw Failure.timedOut
        }
    }
}
