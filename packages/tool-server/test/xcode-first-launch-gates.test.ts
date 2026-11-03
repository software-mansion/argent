/**
 * Issue #1721: while Xcode's component install is pending, no `simctl` or
 * `devicectl` call may reach its wrapper, since each one would start the install
 * and wait for an administrator password. The refusal must reach the agent as a
 * 424 that says what to do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";

const pending = vi.hoisted(() => ({ simctl: false, devicectl: false }));

vi.mock("../src/utils/xcode-first-launch", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/xcode-first-launch")>(
    "../src/utils/xcode-first-launch"
  );
  return {
    ...actual,
    xcodeFirstLaunchPending: (wrapper: "simctl" | "devicectl") => pending[wrapper],
  };
});

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/bootstrap.dylib",
  simulatorServerBinaryPath: () => "/fake/sim-server",
  simulatorServerRunDir: () => "/fake",
  axServiceBinaryPath: () => "/fake/ax-service",
}));

import { createHttpApp } from "../src/http";
import {
  __primeDepCacheForTests,
  __resetDepCacheForTests,
  ensureDeps,
} from "../src/utils/check-deps";
import { XcodeFirstLaunchPendingError } from "../src/utils/dependency-errors";
import { ensureIosDeps } from "../src/utils/cross-platform-tool";
import type { DeviceInfo } from "@argent/registry";
import { simctlPrefix } from "../src/utils/ios-device-sets";
import { ensureDeviceReady, listIosPhysicalDevices } from "../src/utils/ios-device/devicectl";
import { createDescribeTool } from "../src/tools/describe";
import { axServiceBlueprint } from "../src/blueprints/ax-service";
import { nativeDevtoolsBlueprint, precheckNativeDevtools } from "../src/blueprints/native-devtools";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";
import { nativeFindViewsTool } from "../src/tools/native-devtools/native-find-views";
import { nativeFullHierarchyTool } from "../src/tools/native-devtools/native-full-hierarchy";
import { nativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { nativeDevtoolsStatusTool } from "../src/tools/native-devtools/native-devtools-status";
import { nativeViewAtPointTool } from "../src/tools/native-devtools/native-view-at-point";
import { nativeUserInteractableViewAtPointTool } from "../src/tools/native-devtools/native-user-interactable-view-at-point";
import { nativeProfilerSessionBlueprint } from "../src/blueprints/native-profiler-session";
import { nativeProfilerStartTool } from "../src/tools/profiler/native-profiler/native-profiler-start";

const realPlatform = process.platform;
const SIMULATOR: DeviceInfo = {
  id: "11111111-1111-1111-1111-111111111111",
  platform: "ios",
  kind: "simulator",
};
const IPHONE: DeviceInfo = { id: "00008110-000978540290401E", platform: "ios", kind: "device" };

function xcrunCalls(): unknown[][] {
  return execFileMock.mock.calls.filter(([cmd]) => cmd === "xcrun");
}

beforeEach(() => {
  pending.simctl = false;
  pending.devicectl = false;
  execFileMock.mockReset();
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
    cb(null, "");
  });
  __resetDepCacheForTests();
  // Off macOS the physical-device path returns before reaching devicectl.
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("the refusal", () => {
  it("is counted apart from a missing xcrun in failure telemetry", () => {
    expect(getFailureSignal(new XcodeFirstLaunchPendingError(["simctl"]))?.error_code).toBe(
      FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING
    );
  });
});

describe("simctl argv while Xcode's install is pending", () => {
  it("is refused at the builder every simctl call goes through", () => {
    pending.simctl = true;
    expect(() => simctlPrefix(null)).toThrow(XcodeFirstLaunchPendingError);
    expect(() => simctlPrefix("/sets/radon")).toThrow(/sudo \S*xcodebuild -runFirstLaunch/);
  });

  it("is built as before once the install is done", () => {
    expect(simctlPrefix(null)).toEqual(["simctl"]);
    expect(simctlPrefix("/sets/radon")).toEqual(["simctl", "--set", "/sets/radon"]);
  });
});

describe("devicectl while Xcode's install is pending", () => {
  it("is refused before anything is spawned", async () => {
    pending.devicectl = true;
    await expect(ensureDeviceReady("00008110-000978540290401E")).rejects.toBeInstanceOf(
      XcodeFirstLaunchPendingError
    );
    expect(await listIosPhysicalDevices()).toEqual([]);
    expect(xcrunCalls()).toEqual([]);
  });
});

describe("an iOS tool while Xcode's install is pending", () => {
  function describeApp() {
    __primeDepCacheForTests(["xcrun"]);
    const registry = new Registry();
    registry.registerBlueprint(axServiceBlueprint);
    registry.registerBlueprint(nativeDevtoolsBlueprint);
    registry.registerTool(createDescribeTool(registry));
    return createHttpApp(registry).app;
  }

  it("answers 424 with what to do, and spawns no xcrun", async () => {
    pending.simctl = true;
    const res = await request(describeApp()).post("/tools/describe").send({ udid: SIMULATOR.id });

    // Without the preflight, describe swallows the refusal into an empty tree
    // whose hint prescribes a reboot.
    expect(res.status).toBe(424);
    expect(res.body.error).toMatch(/open (that )?Xcode once/);
    expect(res.body.error).toMatch(/sudo \S*xcodebuild -runFirstLaunch/);
    expect(res.body.missing).toEqual(["xcrun"]);
    expect(xcrunCalls()).toEqual([]);
  });

  // list-devices still lists simulators then, so they must stay usable.
  it("is not refused for a simulator while only the devicectl install is pending", async () => {
    pending.devicectl = true;
    const res = await request(describeApp()).post("/tools/describe").send({ udid: SIMULATOR.id });
    expect(res.body.error ?? "").not.toMatch(/runFirstLaunch/);
    expect(xcrunCalls().length).toBeGreaterThan(0);
  });
});

describe("a native-devtools tool while Xcode's install is pending", () => {
  // Its own UDID, so the service's unix socket is not another test file's.
  const SIM: DeviceInfo = {
    id: "FA1E1721-0000-4000-8000-000000000001",
    platform: "ios",
    kind: "simulator",
  };
  const BUNDLE_ID = "com.example.app";
  const AT_POINT = { x: 10, y: 10 };
  const TOOLS = [
    [nativeDescribeScreenTool, {}],
    [nativeFindViewsTool, {}],
    [nativeFullHierarchyTool, {}],
    [nativeNetworkLogsTool, {}],
    [nativeDevtoolsStatusTool, {}],
    [nativeViewAtPointTool, AT_POINT],
    [nativeUserInteractableViewAtPointTool, AT_POINT],
  ] as const;
  let registry: Registry | undefined;

  function nativeApp() {
    __primeDepCacheForTests(["xcrun"]);
    registry = new Registry();
    registry.registerBlueprint(nativeDevtoolsBlueprint);
    for (const [tool] of TOOLS) registry.registerTool(tool as never);
    return createHttpApp(registry).app;
  }

  afterEach(async () => {
    await registry?.dispose();
    registry = undefined;
  });

  it.each(TOOLS.map(([tool, extra]) => [tool.id, extra] as const))(
    "%s answers 424 with what to do",
    async (id, extra) => {
      pending.simctl = true;
      const res = await request(nativeApp())
        .post(`/tools/${id}`)
        .send({ udid: SIM.id, bundleId: BUNDLE_ID, ...extra });

      // Recorded as an init failure, it answered 200 init_failed, which says to reboot.
      expect(res.status).toBe(424);
      expect(res.body.error).toMatch(/-runFirstLaunch/);
      expect(res.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
    }
  );

  it("works on the first call after the install, with no restart", async () => {
    pending.simctl = true;
    const app = nativeApp();
    const status = () =>
      request(app)
        .post("/tools/native-devtools-status")
        .send({ udid: SIM.id, bundleId: BUNDLE_ID });
    for (let call = 0; call < 4; call++) expect((await status()).status).toBe(424);

    pending.simctl = false;
    // The shape the promisified execFile resolves with, for the app-state reads.
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, out?: unknown) => void;
      cb(null, { stdout: "", stderr: "" });
    });
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body.data.status).not.toBe("init_failed");
    expect(res.body.data.envSetup).toBe(true);
  });

  // Flows and debugger-component-tree reach the service without any tool preflight.
  it("does not count a refusal as a failed start of the service", async () => {
    pending.simctl = true;
    const instance = await nativeDevtoolsBlueprint.factory({}, SIM, { device: SIM });
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        await expect(precheckNativeDevtools(instance.api, SIM.id)).rejects.toBeInstanceOf(
          XcodeFirstLaunchPendingError
        );
      }
      expect(instance.api.getInitFailure()).toBeNull();

      pending.simctl = false;
      await expect(precheckNativeDevtools(instance.api, SIM.id)).resolves.toBeNull();
      expect(instance.api.isEnvSetup()).toBe(true);
    } finally {
      await instance.dispose();
    }
  });
});

describe("native-profiler-start while Xcode's install is pending", () => {
  it("answers 424 and is counted as the pending install, not a process-list failure", async () => {
    pending.simctl = true;
    __primeDepCacheForTests(["xcrun"]);
    const registry = new Registry();
    registry.registerBlueprint(nativeProfilerSessionBlueprint);
    registry.registerTool(nativeProfilerStartTool as never);
    try {
      const res = await request(createHttpApp(registry).app)
        .post("/tools/native-profiler-start")
        .send({ device_id: SIMULATOR.id });

      expect(res.status).toBe(424);
      expect(res.body.error).toMatch(/-runFirstLaunch/);
      expect(res.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
      expect(xcrunCalls()).toEqual([]);
    } finally {
      await registry.dispose();
    }
  });
});

describe("the xcrun preflight of a local iOS branch", () => {
  beforeEach(() => __primeDepCacheForTests(["xcrun"]));

  it("passes once both components are installed", async () => {
    await expect(ensureIosDeps(SIMULATOR, ["xcrun"])).resolves.toBeUndefined();
    await expect(ensureIosDeps(IPHONE, ["xcrun"])).resolves.toBeUndefined();
  });

  it("refuses a simulator only while the simctl install is pending", async () => {
    pending.devicectl = true;
    await expect(ensureIosDeps(SIMULATOR, ["xcrun"])).resolves.toBeUndefined();
    pending.simctl = true;
    const err = await ensureIosDeps(SIMULATOR, ["xcrun"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XcodeFirstLaunchPendingError);
    expect((err as Error).message).toMatch(/`simctl` waits .* does not show local iOS simulators/);
  });

  it("refuses a physical iPhone only while the devicectl install is pending", async () => {
    pending.simctl = true;
    await expect(ensureIosDeps(IPHONE, ["xcrun"])).resolves.toBeUndefined();
    pending.devicectl = true;
    const err = await ensureIosDeps(IPHONE, ["xcrun"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XcodeFirstLaunchPendingError);
    expect((err as Error).message).toMatch(/`devicectl` waits .* does not show physical iPhones/);
  });

  it("leaves a branch that does not run xcrun alone", async () => {
    pending.simctl = true;
    pending.devicectl = true;
    await expect(ensureIosDeps(SIMULATOR, [])).resolves.toBeUndefined();
  });

  it("names a missing xcrun before a pending install", async () => {
    pending.simctl = true;
    __resetDepCacheForTests();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(new Error("not found"));
    });
    const err = await ensureIosDeps(SIMULATOR, ["xcrun"]).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(XcodeFirstLaunchPendingError);
    expect((err as Error).message).toMatch(/xcode-select --install/);
  });
});

// Some tools check for xcrun without ever running simctl or devicectl, such as
// native-profiler-stop, which only signals xctrace and exports its trace.
describe("the plain dependency check", () => {
  it("does not look at Xcode's components", async () => {
    pending.simctl = true;
    pending.devicectl = true;
    __primeDepCacheForTests(["xcrun", "adb"]);
    await expect(ensureDeps(["xcrun"])).resolves.toBeUndefined();
    await expect(ensureDeps(["adb"])).resolves.toBeUndefined();
  });
});
