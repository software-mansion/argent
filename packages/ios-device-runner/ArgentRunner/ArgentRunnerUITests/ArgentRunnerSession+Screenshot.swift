import CoreGraphics
import UIKit
import XCTest

private struct CapturedScreen {
    let descriptor: CapturedScreenDescriptor
    let png: Data

    static func unavailable(index: Int) -> CapturedScreen {
        CapturedScreen(
            descriptor: CapturedScreenDescriptor(
                index: index,
                hasPNGData: false,
                pixelWidth: 0,
                pixelHeight: 0,
                appearance: .unknown
            ),
            png: Data()
        )
    }
}

extension ArgentRunnerSession {
    /// Captures a full-screen PNG and returns it inline as base64. A readable
    /// main screen is the fast path. Secondary screens are inspected only when
    /// the main capture is valid and confirmed black.
    func captureScreenshot() -> Envelope {
        let main = Self.captureScreen(XCUIScreen.main, index: 0)

        guard main.descriptor.isUsable else {
            return .failure(
                .commandFailed,
                "main-screen screenshot capture produced no usable image data"
            )
        }

        guard main.descriptor.appearance == .black else {
            return Self.screenshotEnvelope(main.png)
        }

        let screens = XCUIScreen.screens.filter { $0 !== XCUIScreen.main }
        let secondaries = screens.enumerated().map { offset, screen in
            let index = offset + 1
            let probe = withOptionalScreenIssueSuppression {
                Self.captureScreen(screen, index: offset + 1)
            }
            // An optional stale XCUIScreen must not abort later probes. The
            // policy ignores this unusable placeholder.
            return probe.value ?? CapturedScreen.unavailable(index: index)
        }

        switch ActiveScreenPolicy.select(
            main: main.descriptor,
            secondaries: secondaries.map(\.descriptor)
        ) {
        case .main:
            // A single or all-black topology is legitimate. Unknown and tiny
            // alternate captures never displace a usable main capture.
            return Self.screenshotEnvelope(main.png)
        case .secondary(let index):
            guard let selected = secondaries.first(where: {
                $0.descriptor.index == index
            }) else {
                return .failure(
                    .commandFailed,
                    "selected secondary screen disappeared during capture"
                )
            }
            return Self.screenshotEnvelope(selected.png)
        case .ambiguous(let indices):
            let list = indices.map(String.init).joined(separator: ", ")
            return .failure(
                .commandFailed,
                "screenshot capture is ambiguous: main screen is black and multiple secondary screens are readable (indices \(list))",
                hint: "Change the physical display posture, then retry."
            )
        case .mainUnavailable:
            // Guarded above; keep the policy total if its contract changes.
            return .failure(
                .commandFailed,
                "main-screen screenshot capture produced no usable image data"
            )
        }
    }

    private static func screenshotEnvelope(_ png: Data) -> Envelope {
        guard !png.isEmpty else {
            return .failure(
                .commandFailed,
                "screenshot capture produced no data"
            )
        }

        return .success(
            ScreenshotPayload(imageBase64: png.base64EncodedString())
        )
    }

    private static func captureScreen(
        _ screen: XCUIScreen,
        index: Int
    ) -> CapturedScreen {
        let screenshot = screen.screenshot()
        let image = screenshot.image
        let cgImage = image.cgImage
        let png = screenshot.pngRepresentation
        let pixelWidth = cgImage?.width
            ?? Int((image.size.width * image.scale).rounded())
        let pixelHeight = cgImage?.height
            ?? Int((image.size.height * image.scale).rounded())
        let appearance = screenAppearance(for: image)

        return CapturedScreen(
            descriptor: CapturedScreenDescriptor(
                index: index,
                hasPNGData: !png.isEmpty,
                pixelWidth: pixelWidth,
                pixelHeight: pixelHeight,
                appearance: appearance
            ),
            png: png
        )
    }

    /// Returns black only after checking every rendered RGB byte. A cheap
    /// downsample may prove non-black early, but never proves black: sparse or
    /// near-black content can disappear while scaling. Decode/render failures
    /// remain unknown so the main display stays authoritative.
    static func screenAppearance(
        for image: UIImage
    ) -> CapturedScreenAppearance {
        guard let source = image.cgImage, source.width > 0, source.height > 0 else {
            return .unknown
        }

        if sampledImageContainsNonBlackPixel(source) == true {
            return .nonBlack
        }

        let width = source.width
        let height = source.height
        let bytesPerPixel = 4
        let (bytesPerRow, rowOverflow) = width.multipliedReportingOverflow(
            by: bytesPerPixel
        )
        guard !rowOverflow else { return .unknown }
        let (byteCount, overflow) = bytesPerRow.multipliedReportingOverflow(
            by: height
        )
        guard !overflow else { return .unknown }

        var pixels = [UInt8](repeating: 0, count: byteCount)

        let drewImage = pixels.withUnsafeMutableBytes { rawBuffer -> Bool in
            guard let address = rawBuffer.baseAddress,
                let context = CGContext(
                    data: address,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
                        | CGImageAlphaInfo.premultipliedLast.rawValue
                )
            else {
                return false
            }

            context.interpolationQuality = .none
            context.draw(
                source,
                in: CGRect(x: 0, y: 0, width: width, height: height)
            )
            return true
        }

        guard drewImage else { return .unknown }

        for offset in stride(from: 0, to: pixels.count, by: bytesPerPixel) {
            if pixels[offset] != 0 || pixels[offset + 1] != 0
                || pixels[offset + 2] != 0
            {
                return .nonBlack
            }
        }

        return .black
    }

    private static func sampledImageContainsNonBlackPixel(
        _ source: CGImage
    ) -> Bool? {
        let width = min(64, source.width)
        let height = min(64, source.height)
        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)

        let drewImage = pixels.withUnsafeMutableBytes { rawBuffer -> Bool in
            guard let address = rawBuffer.baseAddress,
                let context = CGContext(
                    data: address,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
                        | CGImageAlphaInfo.premultipliedLast.rawValue
                )
            else {
                return false
            }

            context.interpolationQuality = .low
            context.draw(
                source,
                in: CGRect(x: 0, y: 0, width: width, height: height)
            )
            return true
        }

        guard drewImage else { return nil }

        for offset in stride(from: 0, to: pixels.count, by: bytesPerPixel) {
            if pixels[offset] != 0 || pixels[offset + 1] != 0
                || pixels[offset + 2] != 0
            {
                return true
            }
        }

        return false
    }
}
