import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFailureSignal } from "@argent/registry";

/**
 * Issue #615: a cold React Native launch routinely overruns Android's launch
 * wait window, which prints `Status: timeout`. The tool required `Status: ok`,
 * so a launch that had visibly succeeded was reported as a failure and agents
 * retried or "fixed" a non-problem.
 *
 * `Status: timeout` is a latency verdict — the activity was resolved, started
 * and resumed, then failed to report idle in time. It cannot be produced by an
 * intent that failed to resolve. What it cannot tell us is whether the app is
 * still alive, so that is asked directly, and only on this branch.
 */

const shellCalls: string[] = [];
let amStartOut = "Status: ok\n";
/** What the liveness check answers, and which package it was asked about. */
let processRunning = false;
let probeThrows = false;
const probedPackages: string[] = [];

vi.mock("../src/utils/adb", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/adb")>();
  return {
    ...actual,
    isAndroidTv: vi.fn(async () => false),
    adbShell: vi.fn(async (_serial: string, cmd: string) => {
      shellCalls.push(cmd);
      return amStartOut;
    }),
    // Mocked directly rather than through adbShell: the real helper closes over
    // the module's own adbShell, so replacing adbShell alone would not reach it.
    // Asserting on the argument also states the property that matters — which
    // package was asked about — more directly than matching a command string.
    isPackageProcessRunning: vi.fn(async (_serial: string, pkg: string) => {
      probedPackages.push(pkg);
      if (probeThrows) throw new Error("adb: device 'emulator-5554' not found");
      return processRunning;
    }),
  };
});

import {
  androidImpl as launchAndroid,
  classifyAmStartStatus,
} from "../src/tools/launch-app/platforms/android";
import { androidImpl as restartAndroid } from "../src/tools/restart-app/platforms/android";

const UDID = "emulator-5554";
const B = "com.anonymous.myapp";

/** The reporter's verbatim output, including the fingerprints of the timeout path. */
const REPORTED_TIMEOUT = `Starting: Intent { cmp=com.anonymous.myapp/.MainActivity }
Status: timeout
LaunchState: UNKNOWN (-1)
Activity: com.anonymous.myapp/.MainActivity
WaitTime: 11639
Complete`;

/** A successful launch, captured from an emulator. */
const OK_OUT = `Starting: Intent { cmp=com.anonymous.myapp/.MainActivity }
Status: ok
LaunchState: UNKNOWN (0)
Activity: com.anonymous.myapp/.MainActivity
TotalTime: 0
WaitTime: 2073
Complete`;

/** A component that does not exist: no Status: line at all. */
const ERROR_OUT = `Starting: Intent { cmp=com.anonymous.myapp/.NoSuchActivity }
Error type 3
Error: Activity class {com.anonymous.myapp/com.anonymous.myapp.NoSuchActivity} does not exist.`;

const probeCalls = () => probedPackages;

beforeEach(() => {
  shellCalls.length = 0;
  probedPackages.length = 0;
  amStartOut = "Status: ok\n";
  processRunning = false;
  probeThrows = false;
});

describe("classifyAmStartStatus", () => {
  it("reads the reported cold-launch output as a timeout, not a failure", () => {
    expect(classifyAmStartStatus(REPORTED_TIMEOUT)).toBe("timeout");
  });

  it("reads a normal launch as ok", () => {
    expect(classifyAmStartStatus(OK_OUT)).toBe("ok");
  });

  it("does not fail on a benign class name containing 'Error'", () => {
    // The reason this check is a positive match rather than a keyword scan: an
    // earlier /Error|Exception/ matcher rejected launches like this one.
    expect(classifyAmStartStatus("Status: ok\nActivity: com.example/.ErrorReportingActivity")).toBe(
      "ok"
    );
  });

  it("accepts a launch that only brought an existing task to the front", () => {
    expect(
      classifyAmStartStatus(
        "Warning: Activity not started, its current task has been brought to the front\nStatus: ok"
      )
    ).toBe("ok");
  });

  it("rejects an unresolved component, which prints no status at all", () => {
    expect(classifyAmStartStatus(ERROR_OUT)).toBe("rejected");
  });

  it("rejects anything it does not recognise", () => {
    // Closed set, so an unfamiliar or vendor-specific banner fails closed
    // instead of being guessed at.
    expect(classifyAmStartStatus("Status: null")).toBe("rejected");
    expect(classifyAmStartStatus("Status: weird")).toBe("rejected");
    expect(classifyAmStartStatus("")).toBe("rejected");
  });

  it("is not fooled by a status-like string inside an activity name", () => {
    expect(classifyAmStartStatus("Activity: com.example/.Status: ok")).toBe("rejected");
  });

  it("handles the CRLF output a Windows host sees", () => {
    expect(classifyAmStartStatus(REPORTED_TIMEOUT.replace(/\n/g, "\r\n"))).toBe("timeout");
  });
});

describe("launch-app on a slow cold start", () => {
  it("succeeds when the app is running, and says the launch was slow", async () => {
    amStartOut = REPORTED_TIMEOUT;
    processRunning = true;

    const result = await launchAndroid.handler(
      {},
      { udid: UDID, bundleId: B, activity: ".MainActivity" } as never,
      { id: UDID, platform: "android", kind: "emulator" } as never
    );

    expect(result).toMatchObject({
      launched: true,
      bundleId: B,
      note: expect.stringMatching(/wait window/i),
    });
    expect(probeCalls()).toHaveLength(1);
    expect(probeCalls()[0]).toBe(B);
  });

  it("fails when the app is not running — it started and did not stay up", async () => {
    amStartOut = REPORTED_TIMEOUT;
    processRunning = false;

    const err = await launchAndroid
      .handler(
        {},
        { udid: UDID, bundleId: B, activity: ".MainActivity" } as never,
        { id: UDID, platform: "android", kind: "emulator" } as never
      )
      .then(() => null)
      .catch((e: Error) => e);

    expect(getFailureSignal(err!)?.error_code).toBe("ANDROID_LAUNCH_AM_START_FAILED");
    expect(err!.message).toMatch(/no com\.anonymous\.myapp process is running/);
  });

  it("probes the package that was actually launched, not the one named in bundleId", async () => {
    // `activity` may name a different package, and asking about the wrong one
    // could accept a stale process from an earlier session.
    amStartOut = REPORTED_TIMEOUT;
    processRunning = true;

    await launchAndroid.handler(
      {},
      { udid: UDID, bundleId: B, activity: "com.other.app/.Main" } as never,
      { id: UDID, platform: "android", kind: "emulator" } as never
    );

    expect(probeCalls()[0]).toBe("com.other.app");
  });

  it("does not claim a crash when the check itself could not be answered", async () => {
    amStartOut = REPORTED_TIMEOUT;
    probeThrows = true;

    const err = await launchAndroid
      .handler(
        {},
        { udid: UDID, bundleId: B, activity: ".MainActivity" } as never,
        { id: UDID, platform: "android", kind: "emulator" } as never
      )
      .then(() => null)
      .catch((e: Error) => e);

    expect(err!.message).toMatch(/could not be confirmed/);
    expect(err!.message).not.toMatch(/did not stay up/);
  });
});

describe("launch-app on the ordinary path", () => {
  it("returns no note and never probes when the launch reports ok", async () => {
    amStartOut = OK_OUT;

    const result = await launchAndroid.handler(
      {},
      { udid: UDID, bundleId: B, activity: ".MainActivity" } as never,
      { id: UDID, platform: "android", kind: "emulator" } as never
    );

    expect(result).toEqual({ launched: true, bundleId: B });
    expect(probeCalls()).toHaveLength(0);
  });

  it("still fails an unresolved component, without probing", async () => {
    // A shape we do not trust must not be upgraded by a liveness check.
    amStartOut = ERROR_OUT;

    await expect(
      launchAndroid.handler(
        {},
        { udid: UDID, bundleId: B, activity: ".NoSuchActivity" } as never,
        { id: UDID, platform: "android", kind: "emulator" } as never
      )
    ).rejects.toThrow(/am start failed/);
    expect(probeCalls()).toHaveLength(0);
  });
});

describe("restart-app shares the behaviour", () => {
  it("succeeds on a slow relaunch, after force-stopping first", async () => {
    amStartOut = REPORTED_TIMEOUT;
    processRunning = true;

    const result = await restartAndroid.handler(
      {},
      { udid: UDID, bundleId: B, activity: ".MainActivity" } as never,
      { id: UDID, platform: "android", kind: "emulator" } as never
    );

    expect(result).toMatchObject({
      restarted: true,
      bundleId: B,
      note: expect.stringMatching(/wait window/i),
    });
    const stopAt = shellCalls.findIndex((c) => c.includes("force-stop"));
    const startAt = shellCalls.findIndex((c) => c.includes("am start -W"));
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeLessThan(startAt);
  });

  it("still fails a genuinely broken relaunch", async () => {
    // The assertion became async; without awaiting it inside restart-app's own
    // try/catch the rejection would escape and a failed relaunch would report
    // success. This is the test that catches that.
    amStartOut = ERROR_OUT;

    const err = await restartAndroid
      .handler(
        {},
        { udid: UDID, bundleId: B, activity: ".NoSuchActivity" } as never,
        { id: UDID, platform: "android", kind: "emulator" } as never
      )
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(getFailureSignal(err!)?.error_code).toBe("ANDROID_RESTART_FAILED");
  });

  it("fails a slow relaunch whose app did not stay up", async () => {
    amStartOut = REPORTED_TIMEOUT;
    processRunning = false;

    const err = await restartAndroid
      .handler(
        {},
        { udid: UDID, bundleId: B, activity: ".MainActivity" } as never,
        { id: UDID, platform: "android", kind: "emulator" } as never
      )
      .then(() => null)
      .catch((e: Error) => e);

    expect(getFailureSignal(err!)?.error_code).toBe("ANDROID_RESTART_FAILED");
  });
});
