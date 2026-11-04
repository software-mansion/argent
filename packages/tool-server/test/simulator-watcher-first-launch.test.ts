/**
 * Issue #1721: an idle server must not keep asking `simctl` for simulators
 * while Xcode's component install is pending, since every call would start the
 * install and leave another administrator-password request behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pending = vi.hoisted(() => ({ simctl: false }));
const execSimctlMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("../src/utils/xcode-first-launch", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/xcode-first-launch")>(
    "../src/utils/xcode-first-launch"
  );
  return {
    ...actual,
    xcodeFirstLaunchPending: (wrapper: string) => wrapper === "simctl" && pending.simctl,
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
import { startSimulatorWatcher } from "../src/utils/simulator-watcher";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const registry = {
  resolveService: vi.fn(),
  disposeService: vi.fn(async () => {}),
} as unknown as Registry;

const FAKE_APP = "/Applications/Xcode-beta.app";
const FAKE_INSTALL =
  `the Xcode at ${FAKE_APP} once, ` +
  `or run \`sudo ${FAKE_APP}/Contents/Developer/usr/bin/xcodebuild -runFirstLaunch\``;
const realDeveloperDir = process.env.DEVELOPER_DIR;

let stderrWrites: string[];

function installHints(): string[] {
  return stderrWrites.filter((line) => line.includes("-runFirstLaunch"));
}

beforeEach(() => {
  process.env.DEVELOPER_DIR = `${FAKE_APP}/Contents/Developer`;
  pending.simctl = false;
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
  it("starts without calling simctl, so the server binds at once, and says why once", async () => {
    pending.simctl = true;
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(execSimctlMock).not.toHaveBeenCalled();
    expect(installHints()).toHaveLength(1);
    expect(installHints()[0]).toBe(
      "[simulator-watcher] Xcode has not finished installing its system components, so " +
        `simulators are not polled until it has. To install them, open ${FAKE_INSTALL}.\n`
    );
    stop();
  });

  it("polls again on the first tick after the install, and says why again on a new outage", async () => {
    pending.simctl = true;
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(execSimctlMock).not.toHaveBeenCalled();

    pending.simctl = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(1);

    pending.simctl = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(1);
    expect(installHints()).toHaveLength(2);
    stop();
  });
});

describe("simulator-watcher arming a simulator once Xcode's component install is done", () => {
  const SIMULATOR: DeviceInfo = {
    id: processScopedUdid("-1721-4721-8721-172117211721"),
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
      pending.simctl = true;
      const service = await resolveLikeATool();
      // More refusals than it takes to give up on a simulator for good.
      for (let attempt = 0; attempt < MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS; attempt++) {
        await expect(service.ensureEnvReady()).rejects.toBeInstanceOf(XcodeFirstLaunchPendingError);
      }
      expect(service.isEnvSetup()).toBe(false);
      expect(service.getInitFailure()).toBeNull();
      expect(xcrunCalls()).toEqual([]);

      pending.simctl = false;
      const { ready, stop } = startSimulatorWatcher(realRegistry);
      await ready;
      await vi.advanceTimersByTimeAsync(10_000);
      stop();

      expectArmed(service);
    });

    // Every poll of the outage is refused before it can look at a simulator, so
    // the first one after it only finds the simulator and takes up the service,
    // and the next one arms it.
    it("arms a service someone else resolved during the outage, attempting nothing until it ends", async () => {
      pending.simctl = true;
      const { ready, stop } = startSimulatorWatcher(realRegistry);
      await ready;
      const service = await resolveLikeATool();
      const ensureEnvReady = vi.spyOn(service, "ensureEnvReady");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(ensureEnvReady).not.toHaveBeenCalled();
      expect(execSimctlMock).not.toHaveBeenCalled();
      expect(xcrunCalls()).toEqual([]);

      pending.simctl = false;
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
        pending.simctl = true;
        return BOOTED_LIST;
      });
      const { ready, stop } = startSimulatorWatcher(realRegistry);
      await ready;
      const service = await resolveLikeATool();
      const ensureEnvReady = vi.spyOn(service, "ensureEnvReady");
      expect(service.isEnvSetup()).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(ensureEnvReady).not.toHaveBeenCalled();

      pending.simctl = false;
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
