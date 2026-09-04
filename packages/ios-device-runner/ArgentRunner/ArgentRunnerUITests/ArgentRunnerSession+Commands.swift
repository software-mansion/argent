import UIKit
import XCTest

extension DeviceButton {
    /// The XCUIDevice member for this wire name.
    var hardwareButton: XCUIDevice.Button {
        switch self {
        case .home: return .home
        case .volumeUp: return .volumeUp
        case .volumeDown: return .volumeDown
        case .actionButton: return .action
        }
    }
}

extension ArgentRunnerSession {
    enum TargetResolution {
        /// `reactivated` is true when the target was alive but backgrounded and
        /// the runner had to re-front it for this command.
        case ready(XCUIApplication, reactivated: Bool)
        case unavailable(Envelope)
    }

    /// Executes one command on the main thread. Runs XCTest work inside the
    /// exception guard and audits mutating commands against XCTest's failure
    /// and suppressed-issue counters. It never retries: the one runner-side
    /// retry is the snapshot capture's, in captureSnapshot, where the failure
    /// is known; the host retries read-only sends on top of that.
    func performOnMain(_ request: CommandRequest) -> Envelope {
        let failuresBefore = recordedFailureCount()
        let suppressedBefore = currentSuppressedIssueCount()
        var envelope: Envelope?
        var reactivated = false
        // Stale accessibility elements throw NSExceptions. The guard turns
        // them into a failure envelope instead of a process crash.
        let exceptionDescription = ArgentExceptionGuard.runCatching {
            envelope = self.performCommand(request, reactivated: &reactivated)
        }

        // A re-front happens before the command runs, so every reply shape
        // reports it, failures included: the foreground screen changed whether
        // or not the command then succeeded.
        func stamped(_ reply: Envelope) -> Envelope {
            reactivated ? reply.withReactivated() : reply
        }

        if let exceptionDescription {
            return stamped(
                .failure(
                    .commandFailed,
                    exceptionDescription,
                    hint:
                        "The target UI likely changed mid-command; re-observe the screen and retry."
                )
            )
        }

        guard var result = envelope else {
            return stamped(
                .failure(
                    .commandFailed,
                    "\(request.command.rawValue) produced no response"
                )
            )
        }

        // An XCTest failure recorded during a mutating command means the
        // action may not have been performed, so an ok result is demoted.
        if !request.command.isReadOnly, result.ok,
            recordedFailureCount() > failuresBefore
        {
            result = .failure(
                .xctestRecordedFailure,
                "XCTest recorded a failure while executing \(request.command.rawValue); "
                    + "the action may not have been performed.",
                hint:
                    "Re-observe the screen to confirm the effect before retrying."
            )
        }

        // Checked after the demotion above, so a reply that flipped to failure
        // never also warns. A grown suppressed-issue count stays advisory on an
        // ok mutation. See the suppression comment in ArgentRunnerSession.swift.
        if !request.command.isReadOnly, result.ok,
            currentSuppressedIssueCount() > suppressedBefore
        {
            result = result.withWarning(
                "accessibility noise was suppressed during this gesture; "
                    + "re-observe the screen to confirm the effect."
            )
        }

        return stamped(result)
    }

    /// XCTest's cumulative recorded-failure count for this session.
    private func recordedFailureCount() -> Int {
        testRun?.totalFailureCount ?? 0
    }

    /// Runs one command: resolves and fronts the target app for app-scoped
    /// commands, and handles device-scoped commands directly. `reactivated`
    /// is set as soon as the target has been re-fronted, before the command
    /// runs, so the caller can stamp the reply whatever shape it ends up in.
    private func performCommand(
        _ request: CommandRequest,
        reactivated: inout Bool
    ) -> Envelope {
        if request.command.requiresAppBundleId {
            guard let bundleId = request.normalizedAppBundleId else {
                return .failure(
                    .appBundleIdRequired,
                    "\(request.command.rawValue) requires appBundleId",
                    hint: "Launch or target an app first with launch-app."
                )
            }

            // snapshot observes the screen and must not change it, so it never
            // re-fronts a backgrounded target; every other app command may.
            switch foregroundTarget(
                bundleId: bundleId,
                reactivateBackgrounded: request.command != .snapshot
            ) {
            case .unavailable(let envelope):
                return envelope
            case .ready(let app, let didReactivate):
                reactivated = didReactivate
                return performAppCommand(request, on: app)
            }
        }

        switch request.command {
        case .button:
            return pressDeviceButton(request)
        case .screenshot:
            return captureScreenshot()
        case .shutdown:
            return .success(MessagePayload(message: "shutting down"))
        default:
            return .failure(
                .invalidRequest,
                "\(request.command.rawValue) is not a device-scoped command"
            )
        }
    }

    /// Routes an app-scoped command to its gesture, text, viewport, or
    /// snapshot handler.
    private func performAppCommand(
        _ request: CommandRequest,
        on app: XCUIApplication
    ) -> Envelope {
        switch request.command {
        case .viewport:
            return appViewport(app)
        case .tap:
            return performTap(request, on: app)
        case .longPress:
            return performLongPress(request, on: app)
        case .drag:
            return performDrag(request, on: app)
        case .type:
            return performType(request, on: app)
        case .keyboardReturn:
            return performKeyboardReturn(on: app)
        case .keyboardDelete:
            return performKeyboardDelete(on: app)
        case .snapshot:
            return captureSnapshot(of: app)
        default:
            return .failure(
                .invalidRequest,
                "\(request.command.rawValue) is not an app-scoped command"
            )
        }
    }

    /// Presses one hardware button, refusing buttons this device does not have.
    private func pressDeviceButton(_ request: CommandRequest) -> Envelope {
        guard let button = request.button else {
            return .failure(
                .invalidRequest,
                "button requires a button name",
                hint: "Send one of: home, volumeUp, volumeDown, actionButton."
            )
        }

        let device = XCUIDevice.shared

        // press on an absent button is a silent no-op that would read as a
        // successful press, so it is refused up front.
        guard device.hasHardwareButton(button.hardwareButton) else {
            return .failure(
                .unsupportedOperation,
                "this \(UIDevice.current.model) has no \(button.rawValue) button",
                hint:
                    "Press a button this hardware has, or drive the equivalent from on-screen UI."
            )
        }

        device.press(button.hardwareButton)

        return .success(MessagePayload(message: "pressed \(button.rawValue)"))
    }

    /// Resolves the target app for an app-scoped command. A live but
    /// backgrounded target is re-fronted only when `reactivateBackgrounded` is
    /// true (mutating commands and the viewport read that precedes a gesture),
    /// and the reply is then stamped `reactivated: true`. The observation-only
    /// snapshot passes false and is refused with APP_BACKGROUNDED instead, so
    /// reading the screen never changes what is on it. A target that is not
    /// running, or whose state is unreadable, is refused with APP_NOT_AVAILABLE
    /// either way: activating it would be a full launch, and launching is
    /// launch-app's job, never a command side effect.
    private func foregroundTarget(
        bundleId: String,
        reactivateBackgrounded: Bool
    ) -> TargetResolution {
        // A fresh proxy per command avoids stale-target bugs after the app is
        // relaunched behind the runner's back.
        let app = XCUIApplication(bundleIdentifier: bundleId)

        switch app.state {
        case .runningForeground:
            return .ready(app, reactivated: false)
        case .runningBackground, .runningBackgroundSuspended:
            guard reactivateBackgrounded else {
                return .unavailable(
                    .failure(
                        .appBackgrounded,
                        "app '\(bundleId)' is running in the background; "
                            + "the foreground screen is something else",
                        hint:
                            "Use screenshot for the current screen, or launch-app to bring the app back."
                    )
                )
            }

            app.activate()

            guard app.wait(for: .runningForeground, timeout: 15) else {
                return .unavailable(
                    .failure(
                        .appNotAvailable,
                        "app '\(bundleId)' did not reach the foreground",
                        hint:
                            "Check the device screen and retry, or relaunch it with launch-app."
                    )
                )
            }

            // Give the first frame of a fresh activation a moment to render before
            // interacting.
            Thread.sleep(forTimeInterval: 0.25)

            return .ready(app, reactivated: true)
        case .notRunning:
            // activate() on an app that is not running performs a full launch,
            // so this is refused rather than launching implicitly.
            return .unavailable(
                .failure(
                    .appNotAvailable,
                    "app '\(bundleId)' is not running",
                    hint: "Launch it first with launch-app."
                )
            )
        default:
            // Covers .unknown and any state a future SDK adds. On hardware a
            // swipe-killed app this session never launched reports .unknown, so
            // activating it could be a hidden full launch. It is refused as well.
            return .unavailable(
                .failure(
                    .appNotAvailable,
                    "app '\(bundleId)' is not reachable: its state is unreadable",
                    hint: "Launch it first with launch-app."
                )
            )
        }
    }
}
