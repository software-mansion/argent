import XCTest

final class ArgentLaunchPerformanceTests: XCTestCase {
    func testLaunchDuration() {
        guard let bundleID = ProcessInfo.processInfo.environment["ARGENT_LAUNCH_BUNDLE_ID"],
            !bundleID.isEmpty
        else {
            XCTFail("Set TEST_RUNNER_ARGENT_LAUNCH_BUNDLE_ID to the installed app's bundle ID.")
            return
        }

        let options = XCTMeasureOptions()
        // Must match LAUNCH_ITERATIONS in native-profiler/launch-analysis/measure.ts.
        options.iterationCount = 5
        let app = XCUIApplication(bundleIdentifier: bundleID)

        measure(metrics: [XCTApplicationLaunchMetric()], options: options) {
            app.launch()
        }
    }
}
