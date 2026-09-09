import XCTest

extension ArgentRunnerSession {
    /// Captures a full-screen PNG and returns it inline as base64.
    func captureScreenshot() -> Envelope {
        // Screenshots are the fallback observation channel when accessibility
        // snapshots degrade. This path deliberately touches no accessibility APIs.
        let png = XCUIScreen.main.screenshot().pngRepresentation

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
}
