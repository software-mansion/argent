import Foundation

// MARK: - Argent iOS runner wire protocol (v1)
//
// One HTTP POST per command: the request body is a JSON `CommandRequest`, the
// reply a JSON `Envelope`. PROTOCOL.md at the package root documents the
// contract. The TypeScript client under
// packages/tool-server/src/utils/ios-device mirrors these shapes.

enum CommandKind: String, Codable {
    case status
    case viewport
    case tap
    case longPress
    case drag
    case type
    case keyboardReturn
    case button
    case snapshot
    case screenshot
    case shutdown
}

extension CommandKind {
    /// Commands that read state without side effects. The client retries these
    /// freely. Mutating commands are sent exactly once and recovered through
    /// the journal via `status` with `statusCommandId`.
    var isReadOnly: Bool {
        switch self {
        case .status, .viewport, .snapshot, .screenshot:
            return true
        case .tap, .longPress, .drag, .type, .keyboardReturn, .button,
            .shutdown:
            return false
        }
    }

    /// Commands that target an app and therefore require `appBundleId`. A
    /// missing target is treated as a caller error, never redirected to the
    /// runner's own host app.
    var requiresAppBundleId: Bool {
        switch self {
        case .viewport, .tap, .longPress, .drag, .type, .keyboardReturn,
            .snapshot:
            return true
        case .status, .button, .screenshot, .shutdown:
            return false
        }
    }

    /// Whether the journal keeps the full response JSON for `status` recovery.
    var retainsResponseInJournal: Bool {
        switch self {
        // Snapshot and screenshot replies are large and read-only. The client
        // reruns them instead of recovering them from the journal, which keeps
        // them from evicting journaled mutation results.
        case .snapshot, .screenshot:
            return false
        default:
            return true
        }
    }

    /// Main-thread watchdog budget for one command execution. PROTOCOL.md's
    /// "Timeout budgets" table is the authoritative pairing with the client
    /// windows.
    var executionTimeout: TimeInterval {
        switch self {
        // XCTest types long strings in real time, so typing needs extra room.
        case .type: return 55
        // Gestures must outlast XCTest's ~60s pre-event idle wait. A screen that
        // never reports quiescent stalls the wait until XCTest gives up and
        // synthesizes the event anyway, and a shorter budget would abandon a
        // command that still completes.
        case .tap, .longPress, .drag: return 75
        default: return 30
        }
    }
}

/// Hardware buttons the `button` command accepts, mapped onto
/// `XCUIDevice.Button` in ArgentRunnerSession+Commands.swift so this file
/// needs no XCTest import. The power/lock button and the app switcher have no
/// public XCUIDevice API, and `camera` would pin the runner to a newer Xcode.
enum DeviceButton: String, Codable {
    case home
    case volumeUp
    case volumeDown
    case actionButton
}

struct CommandRequest: Codable {
    let command: CommandKind
    let commandId: String?
    /// `status` only: the commandId whose journaled fate is requested.
    let statusCommandId: String?
    /// The app the command targets. Required when `command.requiresAppBundleId`.
    let appBundleId: String?
    /// `tap`/`longPress`: absolute point (in points) in the app's coordinate space.
    let x: Double?
    let y: Double?
    /// `tap`: number of taps in the gesture. Defaults to 1, and 2 gives native
    /// double-tap timing. A multi-tap runs as one command so the inter-tap
    /// delay stays on-device, inside the OS double-tap window.
    let numberOfTaps: Int?
    /// `drag`: absolute start and end points.
    let fromX: Double?
    let fromY: Double?
    let toX: Double?
    let toY: Double?
    /// `longPress`: press duration. `drag`: duration of the movement.
    let durationMs: Double?
    /// `drag`: rest the touch at the destination before lifting so the release
    /// velocity is near zero and the scroll view does not fling. Mirrors the
    /// simulator's ease-out `settle` swipe.
    let settle: Bool?
    /// `type`: the text delivered to the focused input.
    let text: String?
    /// `button`: which hardware button to press.
    let button: DeviceButton?

    /// The trimmed commandId, nil when absent or blank.
    var normalizedCommandId: String? {
        guard
            let trimmed = commandId?.trimmingCharacters(
                in: .whitespacesAndNewlines
            ),
            !trimmed.isEmpty
        else { return nil }
        return trimmed
    }

    /// The trimmed appBundleId, nil when absent or blank.
    var normalizedAppBundleId: String? {
        guard
            let trimmed = appBundleId?.trimmingCharacters(
                in: .whitespacesAndNewlines
            ),
            !trimmed.isEmpty
        else { return nil }
        return trimmed
    }
}

/// Stable error codes shared with the TypeScript client. Only RUNNER_BUSY is
/// client-retryable. RUNNER_WEDGED tells the host to recycle the session.
enum RunnerErrorCode: String {
    case invalidRequest = "INVALID_REQUEST"
    case appBundleIdRequired = "APP_BUNDLE_ID_REQUIRED"
    case appNotAvailable = "APP_NOT_AVAILABLE"
    case appBackgrounded = "APP_BACKGROUNDED"
    case textInputNotFocused = "TEXT_INPUT_NOT_FOCUSED"
    case unsupportedOperation = "UNSUPPORTED_OPERATION"
    case runnerBusy = "RUNNER_BUSY"
    case runnerWedged = "RUNNER_WEDGED"
    case xctestRecordedFailure = "XCTEST_RECORDED_FAILURE"
    case snapshotFailed = "SNAPSHOT_FAILED"
    case commandTimedOut = "COMMAND_TIMED_OUT"
    case commandFailed = "COMMAND_FAILED"
}

struct ErrorPayload: Encodable {
    let code: String
    let message: String
    let hint: String?
}

/// Type-erased Encodable wrapper that lets `Envelope` carry any per-command
/// payload.
struct AnyEncodable: Encodable {
    private let encodeInto: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) { self.encodeInto = value.encode(to:) }
    func encode(to encoder: Encoder) throws { try encodeInto(encoder) }
}

struct Envelope: Encodable {
    let ok: Bool
    let data: AnyEncodable?
    let error: ErrorPayload?
    /// True only when the runner re-fronted a backgrounded target app before
    /// executing the command (see `foregroundTarget`). nil is omitted from the
    /// encoded JSON.
    let reactivated: Bool?
    /// Advisory on an otherwise-ok reply: set when a mutating command succeeded
    /// while the suppressed-issue counter grew, meaning the gesture may have
    /// missed. nil is omitted from the encoded JSON.
    let warning: String?

    /// An ok envelope carrying the payload.
    static func success<T: Encodable>(_ payload: T) -> Envelope {
        Envelope(
            ok: true,
            data: AnyEncodable(payload),
            error: nil,
            reactivated: nil,
            warning: nil
        )
    }

    /// An error envelope with a stable code, a message, and an optional hint.
    static func failure(
        _ code: RunnerErrorCode,
        _ message: String,
        hint: String? = nil
    ) -> Envelope {
        Envelope(
            ok: false,
            data: nil,
            error: ErrorPayload(
                code: code.rawValue,
                message: message,
                hint: hint
            ),
            reactivated: nil,
            warning: nil
        )
    }

    /// A copy of this reply with `reactivated: true`, marking that the target
    /// app was backgrounded and had to be re-fronted before the command ran.
    func withReactivated() -> Envelope {
        Envelope(
            ok: ok,
            data: data,
            error: error,
            reactivated: true,
            warning: warning
        )
    }

    /// A copy of this reply carrying an advisory `warning`. Composes with
    /// `withReactivated()`, so a reply can carry both markers.
    func withWarning(_ warning: String) -> Envelope {
        Envelope(
            ok: ok,
            data: data,
            error: error,
            reactivated: reactivated,
            warning: warning
        )
    }
}

// MARK: - Per-command payloads

struct MessagePayload: Encodable {
    let message: String
}

struct HealthPayload: Encodable {
    let uptimeMs: Double
    /// "idle" | "busy" | "wedged", the main-thread gate's view of the runner.
    let state: String
    /// XCTIssues muted as accessibility noise since launch. Suppression matches
    /// Apple-owned wording in `ArgentRunnerSession.SuppressedIssueWording`, so
    /// a count stuck at zero while `recordedFailures` climbs means an Xcode
    /// release reworded the strings.
    let suppressedIssues: Int
    /// XCTest's cumulative recorded-failure count for the session, read from
    /// `testRun.totalFailureCount`. A failure that gets past suppression turns
    /// a successful mutation into XCTEST_RECORDED_FAILURE.
    let recordedFailures: Int
}

struct CommandStatusPayload: Encodable {
    let commandId: String
    /// "notAccepted" | "accepted" | "started" | "completed" | "failed"
    let state: String
    let command: String?
    let responseOk: Bool?
    /// The completed command's full JSON envelope, when retained.
    let responseJson: String?
    let errorCode: String?
    let errorMessage: String?
    let errorHint: String?
}

struct ViewportPayload: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct ScreenshotPayload: Encodable {
    let imageBase64: String
}

struct SnapshotRect: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct SnapshotNodePayload: Encodable {
    let index: Int
    let type: String
    let label: String?
    let identifier: String?
    let value: String?
    let rect: SnapshotRect
    let enabled: Bool
    let focused: Bool?
    let selected: Bool?
    let depth: Int
    let parentIndex: Int?
}

struct SnapshotQualityPayload: Encodable {
    /// "healthy" | "degraded"
    let state: String
    let backend: String
    let reason: String?
    let reasonCode: String?
}

struct SnapshotPayload: Encodable {
    let nodes: [SnapshotNodePayload]
    let quality: SnapshotQualityPayload
}
