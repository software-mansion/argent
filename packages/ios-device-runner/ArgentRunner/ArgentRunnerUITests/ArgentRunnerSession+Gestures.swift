import XCTest

extension ArgentRunnerSession {
    /// Builds an XCUICoordinate for absolute wire coordinates. Wire `x`/`y` are
    /// screen points in the same space as `XCUIElement.frame` and snapshot rects.
    private func point(_ app: XCUIApplication, _ x: Double, _ y: Double)
        -> XCUICoordinate
    {
        let origin = app.frame.origin

        // withOffset is relative to the app element's origin. Subtract it so a
        // non-zero app.frame.origin is not applied twice. XCUICoordinate handles
        // interface orientation itself.
        return app.coordinate(withNormalizedOffset: .zero).withOffset(
            CGVector(dx: x - origin.x, dy: y - origin.y)
        )
    }

    /// Taps at the wire coordinates, executing `numberOfTaps` taps as one
    /// on-device gesture.
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

        let coordinate = point(app, x, y)
        switch taps {
        case 1:
            coordinate.tap()
        case 2:
            coordinate.doubleTap()
        default:
            // XCUICoordinate has no N-tap API. Sequential taps in an on-device loop
            // have no wire round-trips between them, so inter-tap latency stays
            // inside the OS multi-tap window.
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

        let seconds = max(0.05, (request.durationMs ?? 800) / 1000)
        point(app, x, y).press(forDuration: seconds)

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

        let start = point(app, fromX, fromY)
        let end = point(app, toX, toY)

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
        // Describe normalizes frames against the snapshot's Application root
        // frame, so the viewport must be that same rect, keyboard band included.
        let frame = app.frame

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
