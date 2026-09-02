import { describe, expect, it } from "vitest";
import { extractCrashFailureText } from "../src/utils/ios-device/runner-crash";

// Shape mirrors `xcrun xcresulttool get test-results summary` output. The
// Reminders incident's real failure text is the fixture: a Swift runtime trap
// recorded by xcodebuild after the runner process died mid-snapshot.
const CRASH_TEXT =
  "Crash: ArgentRunnerUITests-Runner at Swift runtime failure: Double value " +
  "cannot be converted to Int because the result would be greater than Int.max";

describe("extractCrashFailureText", () => {
  it("labels a failure that names a crash as the recorded crash, wherever it sits", () => {
    const summary = {
      testFailures: [
        { failureText: CRASH_TEXT },
        { failureText: "runner session ended without a shutdown command" },
      ],
    };
    expect(extractCrashFailureText(summary)).toBe(`recorded crash: ${CRASH_TEXT}`);
  });

  it("labels the last failure as such, not as a crash, when none names one", () => {
    // A runner that exited through XCTest teardown records this shape.
    // Calling its shutdown failure a crash sends the agent after a crash
    // that never happened.
    const summary = {
      testFailures: [
        { failureText: "some earlier assertion" },
        { failureText: "runner session ended without a shutdown command (timedOut)" },
      ],
    };
    expect(extractCrashFailureText(summary)).toBe(
      "last recorded failure: runner session ended without a shutdown command (timedOut)"
    );
  });

  it("keeps only the first line of the text, bounded, after the label", () => {
    const summary = {
      testFailures: [{ failureText: `${"x".repeat(500)}\nsecond line` }],
    };
    const text = extractCrashFailureText(summary);
    expect(text).toBe(`last recorded failure: ${"x".repeat(400)}`);
    expect(text).not.toContain("second line");
  });

  it("returns null on empty or malformed summaries", () => {
    expect(extractCrashFailureText(null)).toBeNull();
    expect(extractCrashFailureText({})).toBeNull();
    expect(extractCrashFailureText({ testFailures: [] })).toBeNull();
    expect(extractCrashFailureText({ testFailures: [{ failureText: 42 }] })).toBeNull();
  });
});
