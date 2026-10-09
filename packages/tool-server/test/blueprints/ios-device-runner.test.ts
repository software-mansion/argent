import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
import { iosDeviceRunnerBlueprint } from "../../src/blueprints/ios-device-runner";
import { IosDeviceTransportError } from "../../src/utils/ios-device/usbmux-protocol";
import {
  createRunnerClient,
  waitForRunnerReady,
  RunnerCommandError,
} from "../../src/utils/ios-device/runner-client";
import {
  ensureRunnerArtifact,
  isProfileExpiredFailure,
  isProfileMissingDeviceFailure,
  killRunnerProcess,
  launchRunner,
  waitForRunnerListeningPort,
} from "../../src/utils/ios-device/runner-build";
import { readRunnerCrashSummary } from "../../src/utils/ios-device/runner-crash";

vi.mock("../../src/utils/ios-device/devicectl", () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));
vi.mock("../../src/utils/ios-device/runner-build", () => ({
  ensureRunnerArtifact: vi.fn(async () => ({
    xctestrunPath: "/tmp/argent-test/base.xctestrun",
    derivedDataPath: "/tmp/argent-test/derived",
    fromCache: true,
  })),
  isProfileExpiredFailure: vi.fn(() => false),
  isProfileMissingDeviceFailure: vi.fn(() => false),
  killRunnerProcess: vi.fn(),
  killStaleRunnersForDevice: vi.fn(async () => {}),
  launchRunner: vi.fn(),
  resolveRunnerSigningConfig: vi.fn(async () => SIGNING_CONFIG),
  waitForRunnerListeningPort: vi.fn(async () => RUNNER_PORT),
}));

const SIGNING_CONFIG = {
  teamId: "ABCDE12345",
  appBundleId: "com.argent.runner.tabcde12345",
  testBundleId: "com.argent.runner.tabcde12345.uitests",
};
/** The port the runner reports in its launch log; the device chooses it. */
const RUNNER_PORT = 49923;
vi.mock("../../src/utils/ios-device/runner-crash", () => ({
  readRunnerCrashSummary: vi.fn(async () => null),
}));
// Keep RunnerCommandError (and everything else) real; only the client factory
// and the readiness poll are seams here.
vi.mock("../../src/utils/ios-device/runner-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/ios-device/runner-client")>();
  return {
    ...actual,
    createRunnerClient: vi.fn(),
    waitForRunnerReady: vi.fn(async () => {}),
  };
});

const DEVICE_UDID = "00008110-000978540290401E";
const LOG_PATH = "/tmp/argent-test/runner.log";
const RESULT_BUNDLE_PATH = "/tmp/argent-test/argent-00008110.xcresult";

function stubLaunch() {
  const child = new EventEmitter();
  vi.mocked(launchRunner).mockResolvedValue({
    child: child as unknown as ChildProcess,
    logPath: LOG_PATH,
    resultBundlePath: RESULT_BUNDLE_PATH,
  });
  const clientRun = vi.fn(
    async (_command: Record<string, unknown>, _opts?: unknown): Promise<unknown> => ({})
  );
  vi.mocked(createRunnerClient).mockReturnValue({ run: clientRun });
  return { child, clientRun };
}

function callFactory() {
  return iosDeviceRunnerBlueprint.factory({}, DEVICE_UDID as unknown as DeviceInfo, {
    device: { id: DEVICE_UDID, platform: "ios", kind: "device" } satisfies DeviceInfo,
  });
}

async function createInstance() {
  const stubs = stubLaunch();
  const instance = await callFactory();
  return { ...stubs, api: instance.api };
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error
  );
}

const recoverable = (error: unknown) => iosDeviceRunnerBlueprint.recoverable?.(error);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ios-device-runner blueprint: mid-command runner death", () => {
  // Regression: the old message-regex classifier missed the 'http' and
  // 'timeout' transport shapes, so a runner dying mid-command skipped the
  // post-mortem on the first error and deferred teardown to the NEXT call.
  it("enriches an 'http' transport failure into the post-mortem on the FIRST call once the child exited", async () => {
    const { api, child, clientRun } = await createInstance();
    const transportError = new IosDeviceTransportError(
      "http",
      "Runner HTTP request failed: read ECONNRESET",
      { retryable: false }
    );
    clientRun.mockRejectedValue(transportError);
    const crash =
      "recorded crash: Crash: ArgentRunnerUITests-Runner at Swift runtime failure: Double " +
      "value cannot be converted to Int because the result would be greater than Int.max";
    vi.mocked(readRunnerCrashSummary).mockResolvedValueOnce(crash);
    child.emit("exit", 1);

    const thrown = (await rejectionOf(
      api.run({ command: "snapshot", appBundleId: "com.example.http" })
    )) as Error;

    expect(clientRun).toHaveBeenCalledTimes(1);
    expect(thrown.message).toBe(
      `iOS device runner exited (code 1) while executing 'snapshot'; ${crash}.` +
        ` The runner respawns on the next call; re-observe the screen and retry. Log: ${LOG_PATH}`
    );
    expect(thrown.cause).toBe(transportError);
    expect(recoverable(thrown)).toBe(true);
    expect(readRunnerCrashSummary).toHaveBeenCalledWith(RESULT_BUNDLE_PATH);
  });

  it("prints the post-mortem's own label, so a teardown exit is not reported as a crash", async () => {
    const { api, child, clientRun } = await createInstance();
    clientRun.mockRejectedValue(
      new IosDeviceTransportError("http", "Runner HTTP request failed: socket hang up", {
        retryable: false,
      })
    );
    // The result bundle of a runner that left through XCTest teardown holds
    // no crash; the summary says which label applies and the blueprint
    // must not add its own.
    vi.mocked(readRunnerCrashSummary).mockResolvedValueOnce(
      "last recorded failure: runner session ended without a shutdown command (timedOut)"
    );
    child.emit("exit", 0);

    const thrown = (await rejectionOf(
      api.run({ command: "tap", appBundleId: "com.example.teardown" })
    )) as Error;

    expect(thrown.message).toBe(
      "iOS device runner exited (code 0) while executing 'tap'; last recorded failure: " +
        "runner session ended without a shutdown command (timedOut)." +
        ` The runner respawns on the next call; re-observe the screen and retry. Log: ${LOG_PATH}`
    );
    expect(thrown.message).not.toContain("recorded crash");
  });

  it("treats a 'timeout' shape the same way and escalates to restart-app on the second death", async () => {
    const { api, child, clientRun } = await createInstance();
    clientRun.mockRejectedValue(
      new IosDeviceTransportError("timeout", "Timed out waiting for XCUITest runner response", {
        retryable: false,
      })
    );
    child.emit("exit", null);

    const first = (await rejectionOf(
      api.run({ command: "tap", appBundleId: "com.example.escalate" })
    )) as Error;
    expect(first.message).toBe(
      `iOS device runner exited (code null) while executing 'tap'.` +
        ` The runner respawns on the next call; re-observe the screen and retry. Log: ${LOG_PATH}`
    );
    expect(recoverable(first)).toBe(true);

    const second = (await rejectionOf(
      api.run({ command: "tap", appBundleId: "com.example.escalate" })
    )) as Error;
    expect(second.message).toBe(
      `iOS device runner exited (code null) while executing 'tap'.` +
        ` Runner death #2 for com.example.escalate in the last 10 minutes;` +
        ` the app's current screen is likely crashing XCTest.` +
        ` Run restart-app for com.example.escalate, then retry. Log: ${LOG_PATH}`
    );
    expect(recoverable(second)).toBe(true);
  });

  it("rethrows the original transport error while the child is still alive", async () => {
    const { api, clientRun } = await createInstance();
    const transportError = new IosDeviceTransportError(
      "http",
      "Runner HTTP request failed: read ECONNRESET",
      { retryable: false }
    );
    clientRun.mockRejectedValue(transportError);

    vi.useFakeTimers();
    try {
      const pending = rejectionOf(api.run({ command: "tap", appBundleId: "com.example.alive" }));
      // The 1.5s settle grace for a straggling exit event; the child never exits.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toBe(transportError);
    } finally {
      vi.useRealTimers();
    }
    expect(readRunnerCrashSummary).not.toHaveBeenCalled();
    expect(recoverable(transportError)).toBe(false);
  });

  it("keeps a pre-send device-unattached verdict as the story even when the child also died", async () => {
    const { api, child, clientRun } = await createInstance();
    const unattached = new IosDeviceTransportError(
      "device-unattached",
      `iOS device ${DEVICE_UDID} is no longer available through usbmux`,
      { retryable: false, hint: "Connect the device by cable." }
    );
    clientRun.mockRejectedValue(unattached);
    child.emit("exit", 1);

    await expect(api.run({ command: "tap", appBundleId: "com.example.cable" })).rejects.toBe(
      unattached
    );
    expect(readRunnerCrashSummary).not.toHaveBeenCalled();
  });

  it("uses the current launch's result bundle for a post-mortem after the profile-missing retry", async () => {
    const { child, clientRun } = stubLaunch();
    // The failed first launch reports a different bundle; the post-mortem
    // must read the bundle of the launch that actually served commands.
    vi.mocked(launchRunner).mockResolvedValueOnce({
      child: child as unknown as ChildProcess,
      logPath: LOG_PATH,
      resultBundlePath: "/tmp/argent-test/first-launch.xcresult",
    });
    vi.mocked(waitForRunnerReady).mockRejectedValueOnce(new Error("no runner"));
    vi.mocked(isProfileMissingDeviceFailure).mockReturnValueOnce(true);
    const { api } = await callFactory();

    clientRun.mockRejectedValue(
      new IosDeviceTransportError("http", "Runner HTTP request failed: socket hang up", {
        retryable: false,
      })
    );
    child.emit("exit", 1);

    await rejectionOf(api.run({ command: "snapshot", appBundleId: "com.example.rebuilt" }));
    expect(launchRunner).toHaveBeenCalledTimes(2);
    expect(ensureRunnerArtifact).toHaveBeenLastCalledWith(SIGNING_CONFIG, {
      destinationUdid: DEVICE_UDID,
      force: true,
    });
    expect(readRunnerCrashSummary).toHaveBeenCalledWith(RESULT_BUNDLE_PATH);
  });
});

describe("ios-device-runner blueprint: launch child exits during the readiness wait", () => {
  function hangReadinessThenExit(child: EventEmitter, code: number) {
    vi.mocked(waitForRunnerReady).mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("exit", code));
      return new Promise(() => {});
    });
  }

  it("short-circuits the hanging wait into the NOT_READY failure, no fake-time advancement", async () => {
    const { child } = stubLaunch();
    hangReadinessThenExit(child, 65);

    const thrown = (await rejectionOf(callFactory())) as Error & { runnerExited?: unknown };
    expect(thrown.message).toContain("xcodebuild exited (code 65) before the runner became ready");
    expect(getFailureSignal(thrown)?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY);
    expect(thrown.runnerExited).toBe(true);
    expect(recoverable(thrown)).toBe(true);
    expect(killRunnerProcess).toHaveBeenCalledTimes(1);
  });

  it("rebuilds against the concrete device when the generic build fails for lack of registered devices", async () => {
    stubLaunch();
    const buildError = new Error(
      "Building the iOS device runner failed.\n\nxcodebuild reported:\n" +
        "error: Your team has no devices from which to generate a provisioning profile."
    );
    vi.mocked(ensureRunnerArtifact).mockRejectedValueOnce(buildError);
    vi.mocked(isProfileMissingDeviceFailure).mockReturnValueOnce(true);

    await callFactory();

    // The predicate reads the build error's MESSAGE (there is no launch log
    // yet), and the concrete-destination rebuild registers the phone.
    expect(isProfileMissingDeviceFailure).toHaveBeenCalledWith(buildError.message);
    expect(ensureRunnerArtifact).toHaveBeenLastCalledWith(SIGNING_CONFIG, {
      destinationUdid: DEVICE_UDID,
      force: true,
    });
    expect(launchRunner).toHaveBeenCalledTimes(1);
  });

  it("does not retry a build failure the predicate does not recognize", async () => {
    stubLaunch();
    vi.mocked(ensureRunnerArtifact).mockRejectedValueOnce(new Error("No Accounts"));

    await expect(callFactory()).rejects.toThrow("No Accounts");
    expect(ensureRunnerArtifact).toHaveBeenCalledTimes(1);
  });

  it("re-signs and retries once when the launch log reports an expired profile", async () => {
    const { child } = stubLaunch();
    hangReadinessThenExit(child, 65);
    vi.mocked(isProfileExpiredFailure).mockReturnValueOnce(true);

    await callFactory();
    expect(ensureRunnerArtifact).toHaveBeenLastCalledWith(SIGNING_CONFIG, {
      destinationUdid: DEVICE_UDID,
      force: true,
    });
    expect(launchRunner).toHaveBeenCalledTimes(2);
  });

  it("proceeds straight to the profile-missing rebuild retry instead of waiting out the poll", async () => {
    const { child } = stubLaunch();
    hangReadinessThenExit(child, 65);
    vi.mocked(isProfileMissingDeviceFailure).mockReturnValueOnce(true);

    await callFactory();
    expect(ensureRunnerArtifact).toHaveBeenLastCalledWith(SIGNING_CONFIG, {
      destinationUdid: DEVICE_UDID,
      force: true,
    });
    expect(launchRunner).toHaveBeenCalledTimes(2);
  });

  it("hands post-ready exits solely to the permanent listener: 'terminated' once, no unhandled rejection", async () => {
    const { child } = stubLaunch();
    const instance = await callFactory();
    // The readiness-race "exit" listener must be gone once startRunner resolves.
    expect(child.listenerCount("exit")).toBe(1);

    const terminated: unknown[] = [];
    instance.events.on("terminated", (error) => terminated.push(error));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      child.emit("exit", 7);
      // An unhandled rejection is reported after the rejecting turn; wait one out.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(terminated).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });
});

describe("ios-device-runner blueprint: the runner's port", () => {
  it("builds the client on the port the runner logged, once the log reports it", async () => {
    stubLaunch();

    await callFactory();

    expect(waitForRunnerListeningPort).toHaveBeenCalledWith(LOG_PATH, { timeoutMs: 120_000 });
    expect(createRunnerClient).toHaveBeenCalledWith(
      expect.objectContaining({ udid: DEVICE_UDID, port: RUNNER_PORT })
    );
    // No client can exist before the port is known.
    expect(vi.mocked(createRunnerClient).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(waitForRunnerListeningPort).mock.invocationCallOrder[0]!
    );
  });

  it("short-circuits a child exit while the port line is still pending", async () => {
    const { child } = stubLaunch();
    vi.mocked(waitForRunnerListeningPort).mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("exit", 70));
      return new Promise(() => {});
    });

    const thrown = (await rejectionOf(callFactory())) as Error;
    expect(thrown.message).toContain("xcodebuild exited (code 70) before the runner became ready");
    expect(getFailureSignal(thrown)?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY);
    expect(createRunnerClient).not.toHaveBeenCalled();
    expect(killRunnerProcess).toHaveBeenCalledTimes(1);
  });

  it("wraps a launch that never logs its port as the not-ready failure", async () => {
    stubLaunch();
    vi.mocked(waitForRunnerListeningPort).mockRejectedValueOnce(
      new Error("the runner did not log a listening port within 120000ms")
    );

    const thrown = (await rejectionOf(callFactory())) as Error;
    expect(thrown.message).toContain(
      "The on-device runner did not become ready: the runner did not log a listening port " +
        "within 120000ms."
    );
    expect(createRunnerClient).not.toHaveBeenCalled();
    expect(waitForRunnerReady).not.toHaveBeenCalled();
    expect(killRunnerProcess).toHaveBeenCalledTimes(1);
  });
});

describe("ios-device-runner blueprint: dispose", () => {
  it("sends shutdown as the mutating command it is, so the send layer cannot resend it", async () => {
    const { child, clientRun } = stubLaunch();
    const instance = await callFactory();

    await instance.dispose();

    // readOnly is what runner-route reads to decide a command may be resent;
    // marking a mutating shutdown read-only both breaks the send-once contract
    // and turns the 3s into three attempts plus backoff.
    expect(clientRun).toHaveBeenCalledWith({ command: "shutdown" }, { timeoutMs: 3_000 });
    expect(killRunnerProcess).toHaveBeenCalledWith(child);
  });

  it("kills the child anyway when the graceful shutdown fails", async () => {
    const { child, clientRun } = stubLaunch();
    const instance = await callFactory();
    clientRun.mockRejectedValueOnce(
      new IosDeviceTransportError("timeout", "runner never answered", { retryable: true })
    );

    await instance.dispose();

    expect(killRunnerProcess).toHaveBeenCalledWith(child);
  });

  it("kills a wedged runner that refuses the shutdown itself", async () => {
    const { child, clientRun } = stubLaunch();
    const instance = await callFactory();
    // A wedged runner refuses every command at once, shutdown included, so
    // the recycle recoverable() asks for is bounded by the shutdown window
    // and ends in the kill either way.
    clientRun.mockRejectedValueOnce(new RunnerCommandError("stuck", { code: "RUNNER_WEDGED" }));

    await instance.dispose();

    expect(clientRun).toHaveBeenCalledWith({ command: "shutdown" }, { timeoutMs: 3_000 });
    expect(killRunnerProcess).toHaveBeenCalledWith(child);
  });
});

describe("ios-device-runner blueprint: recoverable classification", () => {
  it("keys the runner-exited case off the typed marker, not message text", () => {
    expect(recoverable(Object.assign(new Error("anything at all"), { runnerExited: true }))).toBe(
      true
    );
    expect(recoverable(new Error("iOS device runner exited (code 1)"))).toBe(false);
    // Neither bare transport errors nor the retired Wi-Fi-era message shapes
    // revive the case without the marker.
    expect(
      recoverable(
        new IosDeviceTransportError("timeout", "Timed out waiting for XCUITest runner response", {
          retryable: false,
        })
      )
    ).toBe(false);
    expect(recoverable(new Error("connect ECONNREFUSED 127.0.0.1:8080"))).toBe(false);
    expect(recoverable(new Error("the tunnel did not accept connection"))).toBe(false);
    // A RunnerCommandError means the runner answered, so it is alive, with
    // one exception: RUNNER_WEDGED is the runner's own verdict that its main
    // thread is stuck past recovery, and only a fresh runner clears that.
    // RUNNER_BUSY is the runner asking for a moment, not for a recycle.
    expect(recoverable(new RunnerCommandError("Element not found"))).toBe(false);
    expect(recoverable(new RunnerCommandError("busy", { code: "RUNNER_BUSY" }))).toBe(false);
    expect(recoverable(new RunnerCommandError("stuck", { code: "RUNNER_WEDGED" }))).toBe(true);
  });

  it("wraps the runner-not-ready failure with the cause, log path, and trust guidance", async () => {
    stubLaunch();
    vi.mocked(waitForRunnerReady).mockRejectedValueOnce(
      new IosDeviceTransportError("timeout", "Runner did not become ready within 120000ms", {
        retryable: false,
      })
    );

    const thrown = (await rejectionOf(callFactory())) as Error & { runnerExited?: unknown };
    // The full user-facing contract: the underlying cause, where to look, and
    // the first-run trust remediation.
    expect(thrown.message).toContain(
      "The on-device runner did not become ready: Runner did not become ready within 120000ms."
    );
    expect(thrown.message).toContain("Check the log at ");
    expect(thrown.message).toContain(
      "unlock the device and trust the developer app under Settings > General > VPN & Device Management."
    );
    expect(getFailureSignal(thrown)?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY);
  });
});

describe("ios-device-runner blueprint: failure signals", () => {
  it("stamps the factory missing-device error with IOS_DEVICE_RUNNER_FACTORY_OPTIONS_MISSING", async () => {
    const thrown = (await rejectionOf(
      iosDeviceRunnerBlueprint.factory({}, undefined as unknown as DeviceInfo, undefined)
    )) as Error;

    expect(thrown.message).toBe(
      "IosDeviceRunner.factory could not determine the device; pass it via iosDeviceRunnerRef(device)."
    );
    expect(getFailureSignal(thrown)?.error_code).toBe(
      FAILURE_CODES.IOS_DEVICE_RUNNER_FACTORY_OPTIONS_MISSING
    );
  });

  it("stamps the mid-command post-mortem with IOS_DEVICE_RUNNER_EXITED and the exit code", async () => {
    const { api, child, clientRun } = await createInstance();
    clientRun.mockRejectedValue(
      new IosDeviceTransportError("http", "Runner HTTP request failed: read ECONNRESET", {
        retryable: false,
      })
    );
    child.emit("exit", 1);

    const signal = getFailureSignal(
      await rejectionOf(api.run({ command: "snapshot", appBundleId: "com.example.signal" }))
    );
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_EXITED);
    expect(signal?.failure_exit_code).toBe(1);
  });

  it("stamps the terminated event with IOS_DEVICE_RUNNER_TERMINATED, message unchanged", async () => {
    const { child } = stubLaunch();
    const instance = await callFactory();
    const terminated: Array<Error | undefined> = [];
    instance.events.on("terminated", (error) => terminated.push(error));

    child.emit("exit", 7);

    expect(terminated).toHaveLength(1);
    expect(terminated[0]?.message).toBe(`iOS device runner exited (code 7). Log: ${LOG_PATH}`);
    expect(getFailureSignal(terminated[0])?.error_code).toBe(
      FAILURE_CODES.IOS_DEVICE_RUNNER_TERMINATED
    );
  });
});
