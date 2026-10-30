import CoreGraphics
import XCTest

enum CapturedScreenAppearance: Equatable {
    case black
    case nonBlack
    case unknown
}

struct CapturedScreenDescriptor: Equatable {
    let index: Int
    let hasPNGData: Bool
    let pixelWidth: Int
    let pixelHeight: Int
    let appearance: CapturedScreenAppearance

    var isUsable: Bool {
        hasPNGData && pixelWidth > 1 && pixelHeight > 1
    }
}

enum ScreenSelectionDecision: Equatable {
    case main
    case secondary(Int)
    case ambiguous([Int])
    case mainUnavailable
}

enum ActiveScreenPolicy {
    /// Keeps the main display authoritative unless it is a usable, confirmed
    /// black capture and exactly one usable secondary is confirmed non-black.
    /// Dimensions and PNG byte counts establish validity only; they never rank
    /// screens or imply which display is active.
    static func select(
        main: CapturedScreenDescriptor,
        secondaries: [CapturedScreenDescriptor]
    ) -> ScreenSelectionDecision {
        guard main.isUsable else { return .mainUnavailable }
        guard main.appearance == .black else { return .main }

        let readable = secondaries.filter {
            $0.isUsable && $0.appearance == .nonBlack
        }

        switch readable.count {
        case 0:
            // An all-black screen is valid output. Unknown and stale secondary
            // captures are not evidence that another display is active.
            return .main
        case 1:
            return .secondary(readable[0].index)
        default:
            return .ambiguous(readable.map(\.index))
        }
    }
}

enum AppViewportSource: Equatable {
    case original
    case transposedWindow
}

struct AppViewportResolution: Equatable {
    let frame: CGRect
    let source: AppViewportSource
}

struct CapturedSnapshotGeometry: Equatable {
    let rootFrame: CGRect
    let windowFrames: [CGRect]
}

struct AppGeometrySample: Equatable {
    let appFrameBeforeWindows: CGRect
    let windowFrames: [CGRect]
    let appFrameAfterWindows: CGRect
}

enum AppViewportPolicy {
    private static let coordinateTolerance: CGFloat = 1
    private static let areaToleranceRatio: CGFloat = 0.002

    /// Resolves only the observed foldable mismatch: a window with the same
    /// origin and area as the app/root rectangle, but with width and height
    /// transposed. Duplicate windows at the same rectangle coalesce. Any
    /// ambiguity or other geometry preserves the original rectangle.
    static func resolve(
        original: CGRect,
        windowFrames: [CGRect]
    ) -> AppViewportResolution {
        guard isUsable(original) else {
            return AppViewportResolution(frame: original, source: .original)
        }

        let compatible = windowFrames.filter {
            isCompatibleTranspose($0, of: original)
        }
        let distinct = compatible.reduce(into: [CGRect]()) { frames, candidate in
            if !frames.contains(where: { approximatelyEqual($0, candidate) }) {
                frames.append(candidate)
            }
        }

        guard distinct.count == 1, let frame = distinct.first else {
            return AppViewportResolution(frame: original, source: .original)
        }

        return AppViewportResolution(frame: frame, source: .transposedWindow)
    }

    /// Returns the matching window index only for the strict transposed-window
    /// resolution. This keeps the gesture anchor decision testable without an
    /// XCUIElement and prevents ordinary layouts from changing anchors.
    static func coordinateWindowIndex(
        original: CGRect,
        windowFrames: [CGRect]
    ) -> Int? {
        let resolution = resolve(
            original: original,
            windowFrames: windowFrames
        )
        guard resolution.source == .transposedWindow else { return nil }

        return windowFrames.firstIndex {
            approximatelyEqual($0, resolution.frame)
        }
    }

    static func resolveSnapshot(
        _ geometry: CapturedSnapshotGeometry
    ) -> AppViewportResolution {
        resolve(
            original: geometry.rootFrame,
            windowFrames: geometry.windowFrames
        )
    }

    /// Resolves live app geometry only when XCUIApplication.frame remained
    /// stable across the window query. A posture/orientation transition returns
    /// nil so callers can refuse before dispatching an input event.
    static func resolveStableAppGeometry(
        _ sample: AppGeometrySample
    ) -> AppViewportResolution? {
        guard approximatelyEqual(
            sample.appFrameBeforeWindows,
            sample.appFrameAfterWindows
        ) else {
            return nil
        }

        return resolve(
            original: sample.appFrameAfterWindows,
            windowFrames: sample.windowFrames
        )
    }

    static func approximatelyEqual(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        abs(lhs.minX - rhs.minX) <= coordinateTolerance
            && abs(lhs.minY - rhs.minY) <= coordinateTolerance
            && abs(lhs.width - rhs.width) <= coordinateTolerance
            && abs(lhs.height - rhs.height) <= coordinateTolerance
    }

    private static func isCompatibleTranspose(
        _ candidate: CGRect,
        of original: CGRect
    ) -> Bool {
        guard isUsable(candidate),
            abs(original.width - original.height) > coordinateTolerance,
            abs(candidate.width - candidate.height) > coordinateTolerance,
            abs(candidate.minX - original.minX) <= coordinateTolerance,
            abs(candidate.minY - original.minY) <= coordinateTolerance,
            abs(candidate.width - original.height) <= coordinateTolerance,
            abs(candidate.height - original.width) <= coordinateTolerance
        else {
            return false
        }

        let originalArea = original.width * original.height
        let candidateArea = candidate.width * candidate.height
        return abs(candidateArea - originalArea)
            <= max(1, originalArea * areaToleranceRatio)
    }

    private static func isUsable(_ frame: CGRect) -> Bool {
        !frame.isNull && !frame.isInfinite && !frame.isEmpty
            && frame.minX.isFinite && frame.minY.isFinite
            && frame.width.isFinite && frame.height.isFinite
    }
}

private struct AppWindowGeometry {
    let element: XCUIElement
    let frame: CGRect
}

struct AppCoordinateBasis {
    let element: XCUIElement
    let frame: CGRect
}

extension ArgentRunnerSession {
    /// Brackets the live window query with app-frame reads. The returned sample
    /// is rejected if a posture or orientation change crossed the query.
    private static func appGeometry(
        _ app: XCUIApplication
    ) -> (sample: AppGeometrySample, windows: [AppWindowGeometry]) {
        let before = app.frame
        let windows = app.windows.allElementsBoundByIndex.map {
            AppWindowGeometry(element: $0, frame: $0.frame)
        }
        let after = app.frame

        return (
            sample: AppGeometrySample(
                appFrameBeforeWindows: before,
                windowFrames: windows.map(\.frame),
                appFrameAfterWindows: after
            ),
            windows: windows
        )
    }

    static func resolvedAppViewport(
        _ app: XCUIApplication
    ) -> AppViewportResolution? {
        AppViewportPolicy.resolveStableAppGeometry(appGeometry(app).sample)
    }

    static func resolvedCoordinateBasis(
        _ app: XCUIApplication
    ) -> AppCoordinateBasis? {
        let geometry = appGeometry(app)
        guard let resolution = AppViewportPolicy.resolveStableAppGeometry(
            geometry.sample
        ) else {
            return nil
        }

        guard resolution.source == .transposedWindow else {
            return AppCoordinateBasis(element: app, frame: resolution.frame)
        }

        guard let windowIndex = geometry.sample.windowFrames.firstIndex(where: {
            AppViewportPolicy.approximatelyEqual($0, resolution.frame)
        }), geometry.windows.indices.contains(windowIndex)
        else {
            return nil
        }

        let window = geometry.windows[windowIndex]
        return AppCoordinateBasis(element: window.element, frame: window.frame)
    }
}
