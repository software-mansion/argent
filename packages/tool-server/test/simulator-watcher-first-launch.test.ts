/**
 * Issue #1721: an idle server must not keep asking `simctl` for simulators
 * while Xcode's component install is pending, since every call would start the
 * install and leave another administrator-password request behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pending = vi.hoisted(() => ({ value: false, devicectl: false }));
const execSimctlMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("../src/utils/xcode-first-launch", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/xcode-first-launch")>(
    "../src/utils/xcode-first-launch"
  );
  return {
    ...actual,
    xcodeFirstLaunchPending: (wrapper: string) =>
      wrapper === "simctl" ? pending.value : pending.devicectl,
  };
});

// Where a real native-devtools service writes the simulator's launchd environment.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      callback(null, execFileMock(cmd, args));
    },
  };
});

// The signed native binaries are not downloaded on CI, and the path is only ever passed to `simctl`.
vi.mock("@argent/native-devtools-ios", async () => {
  const actual = await vi.importActual<typeof import("@argent/native-devtools-ios")>(
    "@argent/native-devtools-ios"
  );
  return { ...actual, bootstrapDylibPath: () => "/tmp/fake-bootstrap.dylib" };
});

vi.mock("../src/utils/simctl-exec", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/simctl-exec")>(
    "../src/utils/simctl-exec"
  );
  return { ...actual, execSimctl: (...args: unknown[]) => execSimctlMock(...args) };
});

vi.mock("../src/utils/ios-device-sets", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-device-sets")>(
    "../src/utils/ios-device-sets"
  );
  return { ...actual, configuredAdditionalDeviceSets: () => [] };
});

import { Registry, type DeviceInfo } from "@argent/registry";
import {
  MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
  nativeDevtoolsBlueprint,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
  type NativeDevtoolsInitFailure,
} from "../src/blueprints/native-devtools";
import { XcodeFirstLaunchPendingError } from "../src/utils/dependency-errors";
import { SimctlTimeoutError } from "../src/utils/simctl-exec";
import { startSimulatorWatcher } from "../src/utils/simulator-watcher";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const registry = {} as unknown as Registry;

const FAKE_APP = "/Applications/Xcode-beta.app";
const realDeveloperDir = process.env.DEVELOPER_DIR;
const timeout = new SimctlTimeoutError(["simctl", "list", "devices", "--json"], 10_000);

let stderrWrites: string[];

/** What the watcher logs for this wait, as opposed to the line for a `simctl` that timed out. */
function installLines(): string[] {
  return stderrWrites.filter((line) => line.includes("has not finished installing"));
}

function timeoutLines(): string[] {
  return stderrWrites.filter((line) => line.includes("retrying with backoff"));
}

beforeEach(() => {
  process.env.DEVELOPER_DIR = `${FAKE_APP}/Contents/Developer`;
  pending.value = false;
  execSimctlMock.mockReset();
  execSimctlMock.mockResolvedValue('{"devices":{}}');
  stderrWrites = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  });
  vi.useFakeTimers();
});

afterEach(() => {
  if (realDeveloperDir === undefined) delete process.env.DEVELOPER_DIR;
  else process.env.DEVELOPER_DIR = realDeveloperDir;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("simulator-watcher while Xcode's component install is pending", () => {
  it("keeps polling while only devicectl would start the install", async () => {
    pending.devicectl = true;
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      stop();

      expect(execSimctlMock).toHaveBeenCalled();
      expect(stderrWrites).toEqual([]);
    } finally {
      pending.devicectl = false;
    }
  });

  it("starts without calling simctl, so the server binds at once, and says why once", async () => {
    pending.value = true;
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    stop();

    expect(execSimctlMock).not.toHaveBeenCalled();
    expect(stderrWrites).toEqual([
      "[simulator-watcher] Xcode has not finished installing its system components, so " +
        `simulators are not polled until it has. To install them, open the Xcode at ${FAKE_APP} ` +
        `once, or run \`sudo ${FAKE_APP}/Contents/Developer/usr/bin/xcodebuild -runFirstLaunch\`.\n`,
    ]);
  });

  it("polls again on the first tick after the install, and says why again on a new wait", async () => {
    pending.value = true;
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(execSimctlMock).not.toHaveBeenCalled();

    pending.value = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(1);

    pending.value = true;
    await vi.advanceTimersByTimeAsync(30_000);
    stop();
    expect(execSimctlMock).toHaveBeenCalledTimes(1);
    expect(installLines()).toHaveLength(2);
  });

  it("stops polling once the wrapper starts asking for the install, mid-session", async () => {
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(3);

    pending.value = true;
    await vi.advanceTimersByTimeAsync(60_000);
    stop();
    expect(execSimctlMock).toHaveBeenCalledTimes(3);
  });

  // The backoff exists because each attempt restarts the hung install. Once the
  // install is done, nothing is left to hold the next poll back for.
  it("drops a backoff left by earlier timeouts, so the first tick after the install polls", async () => {
    const callTimes: number[] = [];
    execSimctlMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      if (!answers) throw timeout;
      return '{"devices":{}}';
    });
    let answers = false;

    const start = Date.now();
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    // Timeouts at 0, 20 s and 60 s, so the next attempt is due only at 140 s.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callTimes.map((t) => t - start)).toEqual([0, 20_000, 60_000]);

    pending.value = true;
    await vi.advanceTimersByTimeAsync(10_000);
    pending.value = false;
    answers = true;
    await vi.advanceTimersByTimeAsync(10_000);
    stop();

    expect(callTimes.map((t) => t - start)).toEqual([0, 20_000, 60_000, 80_000]);
  });

  it("is no timeout, so a later hang starts its backoff and its log over", async () => {
    const callTimes: number[] = [];
    execSimctlMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      throw timeout;
    });

    const start = Date.now();
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(timeoutLines()).toHaveLength(1);

    pending.value = true;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(callTimes.map((t) => t - start)).toEqual([0, 20_000, 60_000]);
    expect(timeoutLines()).toHaveLength(1);

    pending.value = false;
    callTimes.length = 0;
    await vi.advanceTimersByTimeAsync(40_000);
    stop();

    // The first tick is at 670 s, and the gap after a first timeout is 20 s.
    expect(callTimes.map((t) => t - start)).toEqual([670_000, 690_000]);
    expect(timeoutLines()).toHaveLength(2);
  });

  // A hang the check could not foresee, such as a wrapper it does not recognise,
  // gets the same fix: a bare `sudo xcodebuild` would install another Xcode's components.
  it("names the same Xcode when simctl hangs though no install was seen pending", async () => {
    execSimctlMock.mockRejectedValue(timeout);
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    stop();

    expect(timeoutLines()).toEqual([
      `[simulator-watcher] ${timeout.message}; retrying with backoff until it does. ` +
        `If Xcode was just updated, open the Xcode at ${FAKE_APP} once, ` +
        `or run \`sudo ${FAKE_APP}/Contents/Developer/usr/bin/xcodebuild -runFirstLaunch\`.\n`,
    ]);
  });

  // Asked nothing, so the watcher knows nothing: it must not read that as "shut down".
  it("keeps the simulators it tracks until a poll says they are gone", async () => {
    const udid = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const service = { isEnvSetup: () => true, getInitFailure: () => null, armsEnv: true };
    const resolveService = vi.fn(async () => service);
    const disposeService = vi.fn(async () => {});
    execSimctlMock.mockResolvedValue(
      JSON.stringify({
        devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ udid, state: "Booted" }] },
      })
    );

    const { ready, stop } = startSimulatorWatcher({
      resolveService,
      disposeService,
    } as unknown as Registry);
    await ready;
    expect(resolveService).toHaveBeenCalledTimes(1);

    pending.value = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(disposeService).not.toHaveBeenCalled();

    pending.value = false;
    execSimctlMock.mockResolvedValue('{"devices":{}}');
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    expect(disposeService).toHaveBeenCalledTimes(1);
  });
});

describe("simulator-watcher arming a simulator once Xcode's component install is done", () => {
  const SIMULATOR: DeviceInfo = {
    id: processScopedUdid("-1523-4523-8523-152315231523"),
    platform: "ios",
    kind: "simulator",
  };
  const BOOTED_LIST = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ udid: SIMULATOR.id, state: "Booted" }],
    },
  });

  function xcrunCalls(): string[][] {
    return execFileMock.mock.calls.flatMap(([cmd, args]) => (cmd === "xcrun" ? [args] : []));
  }

  /** The launchd variables written to the simulator, each with its value. */
  function launchctlSetenvs(): string[][] {
    return xcrunCalls().flatMap((args) => {
      const verb = args.indexOf("setenv");
      return args.includes("launchctl") && verb !== -1 ? [args.slice(verb + 1)] : [];
    });
  }

  beforeEach(() => {
    execSimctlMock.mockResolvedValue(BOOTED_LIST);
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: readonly string[]) => ({
      stdout: args.includes("list") ? '{"devices":{}}' : "",
      stderr: "",
    }));
  });

  describe("with a real native-devtools service", () => {
    let realRegistry: Registry;

    function resolveLikeATool(): Promise<NativeDevtoolsApi> {
      const ref = nativeDevtoolsRef(SIMULATOR);
      return realRegistry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
    }

    function expectArmed(service: NativeDevtoolsApi): void {
      expect(service.isEnvSetup()).toBe(true);
      expect(service.getInitFailure()).toBeNull();
      expect(launchctlSetenvs()).toContainEqual([
        "NATIVE_DEVTOOLS_IOS_CDP_SOCKET",
        service.socketPath,
      ]);
    }

    beforeEach(() => {
      realRegistry = new Registry();
      realRegistry.registerBlueprint(nativeDevtoolsBlueprint);
    });

    afterEach(async () => {
      await realRegistry.dispose();
    });

    it("arms a service that was refused while the install was pending, counting no failure", async () => {
      pending.value = true;
      const service = await resolveLikeATool();
      // More refusals than it takes to give up on a simulator for good.
      for (let attempt = 0; attempt < MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS; attempt++) {
        await expect(service.ensureEnvReady()).rejects.toBeInstanceOf(XcodeFirstLaunchPendingError);
      }
      expect(service.isEnvSetup()).toBe(false);
      expect(service.getInitFailure()).toBeNull();
      expect(xcrunCalls()).toEqual([]);

      pending.value = false;
      const { ready, stop } = startSimulatorWatcher(realRegistry);
      await ready;
      await vi.advanceTimersByTimeAsync(10_000);
      stop();

      expectArmed(service);
    });

    // No poll runs during the outage, so the first one after it only finds the
    // simulator and takes up the service, and the next one arms it.
    it("arms a service someone else resolved during the outage, attempting nothing until it ends", async () => {
      pending.value = true;
      const { ready, stop } = startSimulatorWatcher(realRegistry);
      await ready;
      const service = await resolveLikeATool();
      const ensureEnvReady = vi.spyOn(service, "ensureEnvReady");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(ensureEnvReady).not.toHaveBeenCalled();
      expect(execSimctlMock).not.toHaveBeenCalled();
      expect(xcrunCalls()).toEqual([]);

      pending.value = false;
      await vi.advanceTimersByTimeAsync(20_000);
      expectArmed(service);
      expect(ensureEnvReady).toHaveBeenCalledTimes(1);

      // Armed, so it costs later polls nothing.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ensureEnvReady).toHaveBeenCalledTimes(1);
      stop();
    });

    // The install began between a poll's `simctl list` and the setup of the
    // service that poll resolved, so the watcher holds a service with no env.
    it("arms a service it already tracks on the first poll after the install", async () => {
      execSimctlMock.mockImplementationOnce(async () => {
        pending.value = true;
        return BOOTED_LIST;
      });
      const { ready, stop } = startSimulatorWatcher(realRegistry);
      await ready;
      const service = await resolveLikeATool();
      const ensureEnvReady = vi.spyOn(service, "ensureEnvReady");
      expect(service.isEnvSetup()).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(ensureEnvReady).not.toHaveBeenCalled();

      pending.value = false;
      await vi.advanceTimersByTimeAsync(10_000);
      expectArmed(service);
      expect(ensureEnvReady).toHaveBeenCalledTimes(1);
      stop();
    });
  });

  describe("with a service whose state is given", () => {
    function startOn(
      state: { envSetup: boolean; failure: NativeDevtoolsInitFailure | null },
      ensureEnvReady: () => Promise<void>
    ): { ready: Promise<void>; stop: () => void } {
      const service = {
        isEnvSetup: () => state.envSetup,
        getInitFailure: () => state.failure,
        ensureEnvReady,
        armsEnv: true,
      };
      return startSimulatorWatcher({
        resolveService: async () => service,
        disposeService: async () => {},
      } as unknown as Registry);
    }

    it("does not retry a service that has given up", async () => {
      const ensureEnvReady = vi.fn(async () => {});
      const { ready, stop } = startOn(
        {
          envSetup: false,
          failure: {
            attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
            lastError: "Invalid device",
            givenUp: true,
          },
        },
        ensureEnvReady
      );
      await ready;
      await vi.advanceTimersByTimeAsync(30_000);
      stop();

      // Three polls saw it tracked and booted, so leaving it alone was a decision.
      expect(execSimctlMock).toHaveBeenCalledTimes(4);
      expect(ensureEnvReady).not.toHaveBeenCalled();
    });

    it("does not call a service that is already set up", async () => {
      const ensureEnvReady = vi.fn(async () => {});
      const { ready, stop } = startOn({ envSetup: true, failure: null }, ensureEnvReady);
      await ready;
      await vi.advanceTimersByTimeAsync(30_000);
      stop();

      expect(execSimctlMock).toHaveBeenCalledTimes(4);
      expect(ensureEnvReady).not.toHaveBeenCalled();
    });
  });
});
