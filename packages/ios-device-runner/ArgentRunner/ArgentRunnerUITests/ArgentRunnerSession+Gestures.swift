import XCTest

extension ArgentRunnerSession {
    private func unstableAppGeometryEnvelope() -> Envelope {
        .failure(
            .commandFailed,
            "the app changed display geometry while resolving coordinates",
            hint: "Wait for the posture or orientation change to finish, re-observe, then retry."
        )
    }

    /// Builds an XCUICoordinate for absolute wire coordinates. Wire `x`/`y` are
    /// screen points in the same space as `XCUIElement.frame` and snapshot rects.
    /// The anchor is normally the Application. For a strictly resolved
    /// transposed app window it is that Window, so XCTest routes the event to
    /// the same display whose viewport supplied the wire coordinates.
    private func point(
        _ anchor: XCUIElement,
        _ x: Double,
        _ y: Double,
        relativeTo origin: CGPoint
    ) -> XCUICoordinate {
        // withOffset is relative to the anchor's origin. Subtract it so a
        // non-zero frame origin is not applied twice. XCUICoordinate handles
        // interface orientation itself.
        return anchor.coordinate(withNormalizedOffset: .zero).withOffset(
            CGVector(dx: x - origin.x, dy: y - origin.y)
        )
    }

    /// Taps at the wire coordinates: one tap, the native double-tap when
    /// `numberOfTaps` is 2, or a loop of single taps above that. XCUICoordinate
    /// has no N-tap API, and the loop is not one gesture on hardware: each tap
    /// is its own synthesized event behind XCTest's idle wait and an XPC round
    /// trip, hundreds of milliseconds apart, so the taps land separately and do
    /// not trigger a multi-tap recognizer. That is documented, not refused.
    func performTap(_ request: CommandRequest, on app: XCUIApplication)
        -> Envelope
    {
        guard let x = request.x, let y = request.y else {
            return .failure(.invalidRequest, "tap requires x and y")
        }

        let taps = request.numberOfTaps ?? 1
        guard taps >= 1 else {
            return .failure(.invalidRequest, "tap requires numberOfTaps >= 1")
        }

        guard let basis = Self.resolvedCoordinateBasis(app) else {
            return unstableAppGeometryEnvelope()
        }
        let coordinate = point(
            basis.element,
            x,
            y,
            relativeTo: basis.frame.origin
        )

        switch taps {
        case 1:
            coordinate.tap()
        case 2:
            coordinate.doubleTap()
        default:
            // Separate taps, not one gesture (see the doc comment above).
            for _ in 0..<taps {
                coordinate.tap()
            }
        }

        return .success(MessagePayload(message: "tapped"))
    }

    /// Presses at the wire coordinates for the requested duration.
    func performLongPress(_ request: CommandRequest, on app: XCUIApplication)
        -> Envelope
    {
        guard let x = request.x, let y = request.y else {
            return .failure(.invalidRequest, "longPress requires x and y")
        }

        guard let basis = Self.resolvedCoordinateBasis(app) else {
            return unstableAppGeometryEnvelope()
        }
        let seconds = max(0.05, (request.durationMs ?? 800) / 1000)
        point(basis.element, x, y, relativeTo: basis.frame.origin).press(
            forDuration: seconds
        )

        return .success(MessagePayload(message: "long-pressed"))
    }

    /// Drags between the wire coordinates, honoring the requested hold before
    /// the movement, the movement duration, and the `settle` release behavior.
    func performDrag(_ request: CommandRequest, on app: XCUIApplication)
        -> Envelope
    {
        guard let fromX = request.fromX, let fromY = request.fromY,
            let toX = request.toX, let toY = request.toY
        else {
            return .failure(
                .invalidRequest,
                "drag requires fromX, fromY, toX and toY"
            )
        }

        guard let basis = Self.resolvedCoordinateBasis(app) else {
            return unstableAppGeometryEnvelope()
        }
        let origin = basis.frame.origin
        let start = point(basis.element, fromX, fromY, relativeTo: origin)
        let end = point(basis.element, toX, toY, relativeTo: origin)

        // The press before the movement. 50 ms is a plain drag; a long-press
        // pickup needs the caller's holdMs, since a short press never lifts a
        // draggable item no matter how slowly the finger then moves.
        let startHold = max((request.holdMs ?? 50) / 1000, 0.05)
        // A `settle` drag rests at the destination before lifting, so the scroll
        // view reads near-zero release velocity and does not fling.
        let endHold = request.settle == true ? 0.3 : 0.05
        let velocity: XCUIGestureVelocity

        if let durationMs = request.durationMs, durationMs > 0 {
            // Honor the requested duration through drag velocity (points/second),
            // clamped to a range XCTest executes faithfully.
            let distance =
                ((toX - fromX) * (toX - fromX) + (toY - fromY) * (toY - fromY))
                .squareRoot()

            let pointsPerSecond = min(
                max(distance / (durationMs / 1000), 60),
                5000
            )

            velocity = XCUIGestureVelocity(rawValue: CGFloat(pointsPerSecond))
        } else {
            velocity = .default
        }

        start.press(
            forDuration: startHold,
            thenDragTo: end,
            withVelocity: velocity,
            thenHoldForDuration: endHold
        )

        return .success(MessagePayload(message: "dragged"))
    }

    /// Reports the interaction viewport, the rectangle that normalized 0-1
    /// coordinates map into.
    func appViewport(_ app: XCUIApplication) -> Envelope {
        // Live geometry is bracketed by app-frame reads. Refuse a transition
        // instead of returning a viewport that the following gesture cannot use.
        guard let viewport = Self.resolvedAppViewport(app) else {
            return unstableAppGeometryEnvelope()
        }
        let frame = viewport.frame

        guard !frame.isNull, !frame.isInfinite, !frame.isEmpty else {
            return .failure(
                .appNotAvailable,
                "the app's interaction viewport is unavailable",
                hint: "Bring the app to the foreground, then retry."
            )
        }

        return .success(
            ViewportPayload(
                x: frame.minX,
                y: frame.minY,
                width: frame.width,
                height: frame.height
            )
        )
    }
}
