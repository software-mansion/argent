import XCTest

/// XCTest waits up to 60s before and after every synthesized event for the
/// app to report idle. A screen that never does, such as one holding a paused
/// UIViewPropertyAnimator (expo-blur), stalls each gesture for two minutes,
/// past its watchdog budget. The runner skips those waits and runs XCTest's
/// idle check itself under a short cap. Every API here is XCTest SPI, probed
/// before use: when any is missing, the event runs with XCTest's own waits.
extension ArgentRunnerSession {
    /// The longest a gesture waits for the app to go idle before its event.
    /// Covers a navigation transition, so a gesture sent right after the one
    /// that started it lands on the new screen instead of mid-transition.
    static let preEventSettleTimeout: TimeInterval = 2

    private static let performWithInteractionOptions = NSSelectorFromString(
        "_performWithInteractionOptions:block:"
    )
    /// Bit 1 skips the pre-event wait, bit 2 the post-event one.
    private static let skipQuiescenceOptions: UInt32 = 0b11

    private static let applicationImpl = NSSelectorFromString("applicationImpl")
    private static let currentProcess = NSSelectorFromString("currentProcess")
    private static let initiateQuiescenceChecks = NSSelectorFromString(
        "_initiateQuiescenceChecksIncludingAnimationsIdle:"
    )
    private static let makeQuiescenceExpectation = NSSelectorFromString(
        "_makeQuiescenceExpectation"
    )

    /// Waits at most `preEventSettleTimeout` for `app` to go idle, then runs
    /// `body`, which synthesizes events into it, without XCTest's waits.
    func skippingQuiescence(of app: XCUIApplication, _ body: () -> Void) {
        let selector = Self.performWithInteractionOptions

        guard app.responds(to: selector),
            awaitQuiescence(of: app, timeout: Self.preEventSettleTimeout)
        else {
            body()
            return
        }

        typealias Perform = @convention(c) (
            NSObject, Selector, UInt32, @convention(block) () -> Void
        ) -> Void
        let perform = unsafeBitCast(app.method(for: selector), to: Perform.self)

        // XCTest restores the prior options only when the block returns, and
        // every XCUIApplication for this bundle id shares them, so an
        // exception must not unwind through it.
        var exception: NSException?
        withoutActuallyEscaping(body) { body in
            perform(app, selector, Self.skipQuiescenceOptions) {
                exception = ArgentExceptionGuard.exception(from: body)
            }
        }
        exception?.raise()
    }

    /// XCTest's own idle check (event loop and animations), under `timeout`.
    /// False when any SPI it needs is missing.
    private func awaitQuiescence(of app: XCUIApplication, timeout: TimeInterval)
        -> Bool
    {
        guard
            let impl = Self.object(app, Self.applicationImpl),
            let process = Self.object(impl, Self.currentProcess),
            process.responds(to: Self.initiateQuiescenceChecks)
        else {
            return false
        }

        typealias Initiate = @convention(c) (NSObject, Selector, Bool) -> Void
        let initiate = unsafeBitCast(
            process.method(for: Self.initiateQuiescenceChecks),
            to: Initiate.self
        )
        initiate(process, Self.initiateQuiescenceChecks, true)

        guard
            let expectation = Self.object(process, Self.makeQuiescenceExpectation)
                as? XCTestExpectation
        else {
            return false
        }

        _ = XCTWaiter.wait(for: [expectation], timeout: timeout)
        return true
    }

    /// The object a zero-argument getter returns, or nil when `target` lacks it.
    private static func object(_ target: NSObject, _ getter: Selector) -> NSObject? {
        guard target.responds(to: getter) else { return nil }
        return target.perform(getter)?.takeUnretainedValue() as? NSObject
    }
}
