import CoreGraphics
import UIKit
import XCTest

final class DisplayRoutingPolicyTests: XCTestCase {
    private func screen(
        _ index: Int,
        appearance: CapturedScreenAppearance,
        width: Int = 100,
        height: Int = 200,
        hasPNGData: Bool = true
    ) -> CapturedScreenDescriptor {
        CapturedScreenDescriptor(
            index: index,
            hasPNGData: hasPNGData,
            pixelWidth: width,
            pixelHeight: height,
            appearance: appearance
        )
    }

    private func image(
        width: Int,
        height: Int,
        pixels: [UInt8]
    ) -> UIImage? {
        guard pixels.count == width * height * 4,
            let provider = CGDataProvider(data: Data(pixels) as CFData),
            let cgImage = CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(
                    rawValue: CGBitmapInfo.byteOrder32Big.rawValue
                        | CGImageAlphaInfo.premultipliedLast.rawValue
                ),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
            )
        else {
            return nil
        }

        return UIImage(cgImage: cgImage)
    }

    private func opaqueBlackPixels(width: Int, height: Int) -> [UInt8] {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for offset in stride(from: 3, to: pixels.count, by: 4) {
            pixels[offset] = 255
        }
        return pixels
    }

    func testReadableMainStaysAuthoritative() {
        XCTAssertEqual(
            ActiveScreenPolicy.select(
                main: screen(0, appearance: .nonBlack),
                secondaries: []
            ),
            .main
        )
    }

    func testUnknownMainStaysAuthoritative() {
        XCTAssertEqual(
            ActiveScreenPolicy.select(
                main: screen(0, appearance: .unknown),
                secondaries: [screen(1, appearance: .nonBlack)]
            ),
            .main
        )
    }

    func testSingleBlackScreenIsPreserved() {
        XCTAssertEqual(
            ActiveScreenPolicy.select(
                main: screen(0, appearance: .black),
                secondaries: []
            ),
            .main
        )
    }

    func testBlackMainSelectsOneReadableSecondary() {
        XCTAssertEqual(
            ActiveScreenPolicy.select(
                main: screen(0, appearance: .black),
                secondaries: [screen(1, appearance: .nonBlack)]
            ),
            .secondary(1)
        )
    }

    func testMultipleReadableSecondariesAreAmbiguous() {
        XCTAssertEqual(
            ActiveScreenPolicy.select(
                main: screen(0, appearance: .black),
                secondaries: [
                    screen(1, appearance: .nonBlack),
                    screen(2, appearance: .nonBlack),
                ]
            ),
            .ambiguous([1, 2])
        )
    }

    func testAllBlackTopologyPreservesMain() {
        XCTAssertEqual(
            ActiveScreenPolicy.select(
                main: screen(0, appearance: .black),
                secondaries: [screen(1, appearance: .black)]
            ),
            .main
        )
    }

    func testTinyStaleSecondaryIsIgnored() {
        XCTAssertEqual(
            ActiveScreenPolicy.select(
                main: screen(0, appearance: .black),
                secondaries: [
                    screen(
                        1,
                        appearance: .nonBlack,
                        width: 1,
                        height: 1
                    )
                ]
            ),
            .main
        )
    }

    func testEmptyMainPNGIsUnavailable() {
        XCTAssertEqual(
            ActiveScreenPolicy.select(
                main: screen(
                    0,
                    appearance: .black,
                    hasPNGData: false
                ),
                secondaries: [screen(1, appearance: .nonBlack)]
            ),
            .mainUnavailable
        )
    }

    func testEmptySecondaryPNGIsIgnored() {
        XCTAssertEqual(
            ActiveScreenPolicy.select(
                main: screen(0, appearance: .black),
                secondaries: [
                    screen(
                        1,
                        appearance: .nonBlack,
                        hasPNGData: false
                    )
                ]
            ),
            .main
        )
    }

    func testOrdinaryPortraitAndLandscapeKeepOriginalViewport() {
        let portrait = CGRect(x: 0, y: 0, width: 390, height: 844)
        let landscape = CGRect(x: 0, y: 0, width: 844, height: 390)

        XCTAssertEqual(
            AppViewportPolicy.resolve(
                original: portrait,
                windowFrames: [portrait]
            ),
            AppViewportResolution(frame: portrait, source: .original)
        )
        XCTAssertEqual(
            AppViewportPolicy.resolve(
                original: landscape,
                windowFrames: [landscape]
            ),
            AppViewportResolution(frame: landscape, source: .original)
        )
        XCTAssertNil(
            AppViewportPolicy.coordinateWindowIndex(
                original: portrait,
                windowFrames: [portrait]
            )
        )
    }

    func testUniqueTransposedWindowResolvesViewport() {
        let portrait = CGRect(x: 0, y: 0, width: 669, height: 951)
        let landscape = CGRect(x: 0, y: 0, width: 951, height: 669)

        XCTAssertEqual(
            AppViewportPolicy.resolve(
                original: portrait,
                windowFrames: [landscape]
            ),
            AppViewportResolution(frame: landscape, source: .transposedWindow)
        )
        XCTAssertEqual(
            AppViewportPolicy.coordinateWindowIndex(
                original: portrait,
                windowFrames: [landscape]
            ),
            0
        )
    }

    func testDuplicateIdenticalTransposedWindowsCoalesce() {
        let portrait = CGRect(x: 0, y: 0, width: 669, height: 951)
        let landscape = CGRect(x: 0, y: 0, width: 951, height: 669)

        XCTAssertEqual(
            AppViewportPolicy.resolve(
                original: portrait,
                windowFrames: [landscape, landscape]
            ).source,
            .transposedWindow
        )
        XCTAssertEqual(
            AppViewportPolicy.coordinateWindowIndex(
                original: portrait,
                windowFrames: [landscape, landscape]
            ),
            0
        )
    }

    func testAmbiguousTransposedWindowsKeepOriginalViewport() {
        let portrait = CGRect(x: 0, y: 0, width: 669, height: 951)
        let left = CGRect(x: -1, y: 0, width: 951, height: 669)
        let right = CGRect(x: 1, y: 0, width: 951, height: 669)

        XCTAssertEqual(
            AppViewportPolicy.resolve(
                original: portrait,
                windowFrames: [left, right]
            ),
            AppViewportResolution(frame: portrait, source: .original)
        )
    }

    func testDifferentOriginDoesNotResolveViewport() {
        let portrait = CGRect(x: 0, y: 0, width: 669, height: 951)
        let shifted = CGRect(x: 10, y: 0, width: 951, height: 669)

        XCTAssertEqual(
            AppViewportPolicy.resolve(
                original: portrait,
                windowFrames: [shifted]
            ).source,
            .original
        )
    }

    func testDifferentAreaDoesNotResolveViewport() {
        let portrait = CGRect(x: 0, y: 0, width: 669, height: 951)
        let differentArea = CGRect(x: 0, y: 0, width: 951.9, height: 669.9)

        XCTAssertEqual(
            AppViewportPolicy.resolve(
                original: portrait,
                windowFrames: [differentArea]
            ).source,
            .original
        )
    }

    func testSnapshotViewportUsesCapturedWindowGeometry() {
        let root = CGRect(x: 0, y: 0, width: 669, height: 951)
        let capturedWindow = CGRect(x: 0, y: 0, width: 951, height: 669)

        XCTAssertEqual(
            AppViewportPolicy.resolveSnapshot(
                CapturedSnapshotGeometry(
                    rootFrame: root,
                    windowFrames: [capturedWindow]
                )
            ),
            AppViewportResolution(
                frame: capturedWindow,
                source: .transposedWindow
            )
        )
    }

    func testSnapshotViewportCannotMixInUnrelatedLiveGeometry() {
        let root = CGRect(x: 0, y: 0, width: 669, height: 951)
        let capturedWindow = root
        let unrelatedLiveWindow = CGRect(x: 0, y: 0, width: 951, height: 669)

        XCTAssertEqual(
            AppViewportPolicy.resolveSnapshot(
                CapturedSnapshotGeometry(
                    rootFrame: root,
                    windowFrames: [capturedWindow]
                )
            ),
            AppViewportResolution(frame: root, source: .original)
        )
        XCTAssertNotEqual(capturedWindow, unrelatedLiveWindow)
    }

    func testStableLiveGeometryResolvesTransposedWindow() {
        let portrait = CGRect(x: 0, y: 0, width: 669, height: 951)
        let landscape = CGRect(x: 0, y: 0, width: 951, height: 669)

        XCTAssertEqual(
            AppViewportPolicy.resolveStableAppGeometry(
                AppGeometrySample(
                    appFrameBeforeWindows: portrait,
                    windowFrames: [landscape, landscape],
                    appFrameAfterWindows: portrait
                )
            ),
            AppViewportResolution(
                frame: landscape,
                source: .transposedWindow
            )
        )
    }

    func testChangingLiveGeometryIsRejected() {
        let portrait = CGRect(x: 0, y: 0, width: 669, height: 951)
        let landscape = CGRect(x: 0, y: 0, width: 951, height: 669)

        XCTAssertNil(
            AppViewportPolicy.resolveStableAppGeometry(
                AppGeometrySample(
                    appFrameBeforeWindows: portrait,
                    windowFrames: [landscape],
                    appFrameAfterWindows: landscape
                )
            )
        )
    }

    func testExactBlackImageIsBlack() throws {
        let image = try XCTUnwrap(
            image(
                width: 4,
                height: 4,
                pixels: opaqueBlackPixels(width: 4, height: 4)
            )
        )

        XCTAssertEqual(
            ArgentRunnerSession.screenAppearance(for: image),
            .black
        )
    }

    func testNearBlackImageIsNonBlack() throws {
        var pixels = opaqueBlackPixels(width: 4, height: 4)
        pixels[0] = 1
        let image = try XCTUnwrap(image(width: 4, height: 4, pixels: pixels))

        XCTAssertEqual(
            ArgentRunnerSession.screenAppearance(for: image),
            .nonBlack
        )
    }

    func testIsolatedBrightPixelIsNonBlack() throws {
        let width = 128
        let height = 128
        var pixels = opaqueBlackPixels(width: width, height: height)
        let isolatedPixelOffset = ((height / 2) * width + (width / 2)) * 4
        pixels[isolatedPixelOffset] = 255
        let image = try XCTUnwrap(
            image(width: width, height: height, pixels: pixels)
        )

        XCTAssertEqual(
            ArgentRunnerSession.screenAppearance(for: image),
            .nonBlack
        )
    }

    func testImageWithoutCGImageIsUnknown() {
        XCTAssertEqual(
            ArgentRunnerSession.screenAppearance(for: UIImage()),
            .unknown
        )
    }

    func testOptionalScreenIssueSuppressionIsExactAndScoped() {
        let bareDescription = "Screen does not exist"
        let wrappedDescription =
            "Failed to get screenshot: Failed to create screenshot. "
            + "Screen does not exist. Make sure the screen is still connected."

        XCTAssertTrue(
            ArgentRunnerSession.shouldSuppressOptionalScreenIssue(
                bareDescription,
                probeActive: true
            )
        )
        XCTAssertTrue(
            ArgentRunnerSession.shouldSuppressOptionalScreenIssue(
                wrappedDescription,
                probeActive: true
            )
        )
        XCTAssertFalse(
            ArgentRunnerSession.shouldSuppressOptionalScreenIssue(
                bareDescription,
                probeActive: false
            )
        )
        XCTAssertFalse(
            ArgentRunnerSession.shouldSuppressOptionalScreenIssue(
                wrappedDescription,
                probeActive: false
            )
        )
        XCTAssertFalse(
            ArgentRunnerSession.shouldSuppressOptionalScreenIssue(
                "Unexpected failure: \(wrappedDescription)",
                probeActive: true
            )
        )
        XCTAssertFalse(
            ArgentRunnerSession.shouldSuppressOptionalScreenIssue(
                "\(wrappedDescription) Additional context.",
                probeActive: true
            )
        )
    }

    func testOptionalScreenProbeScopeResetsAfterObjectiveCException() {
        let scope = OptionalScreenProbeScope()
        let result: OptionalScreenProbeResult<Int> = scope.run {
            NSException(
                name: NSExceptionName(
                    rawValue: "ArgentOptionalScreenProbeTest"
                ),
                reason: "injected test exception",
                userInfo: nil
            ).raise()
            return 1
        }

        XCTAssertNil(result.value)
        XCTAssertNotNil(result.exceptionDescription)
        XCTAssertFalse(scope.isActive)
        XCTAssertEqual(scope.run { 2 }.value, 2)
        XCTAssertFalse(
            ArgentRunnerSession.shouldSuppressOptionalScreenIssue(
                "Screen does not exist",
                probeActive: scope.isActive
            )
        )
    }
}
