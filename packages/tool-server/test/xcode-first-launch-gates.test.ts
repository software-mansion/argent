/**
 * Issue #1721: while Xcode's component install is pending, no `simctl` or
 * `devicectl` call may reach its wrapper, since each one would start the install
 * and wait for an administrator password. The refusal must reach the agent as a
 * 424 that says what to do.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  FAILURE_CODES,
  getFailureSignal,
  Registry,
  TypedEventEmitter,
  type ServiceEvents,
} from "@argent/registry";

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
import { dispatchByPlatform, ensureIosDeps } from "../src/utils/cross-platform-tool";
import type { DeviceInfo, ToolCapability } from "@argent/registry";
import { isFoldableDeviceType } from "../src/utils/ios-devices";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { simctlPrefix } from "../src/utils/ios-device-sets";
import { ensureDeviceReady, listIosPhysicalDevices } from "../src/utils/ios-device/devicectl";
import { createDescribeTool } from "../src/tools/describe";
import { axServiceBlueprint } from "../src/blueprints/ax-service";
import {
  nativeDevtoolsBlueprint,
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
} from "../src/blueprints/native-devtools";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";
import { nativeFindViewsTool } from "../src/tools/native-devtools/native-find-views";
import { nativeFullHierarchyTool } from "../src/tools/native-devtools/native-full-hierarchy";
import { nativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { nativeDevtoolsStatusTool } from "../src/tools/native-devtools/native-devtools-status";
import { nativeViewAtPointTool } from "../src/tools/native-devtools/native-view-at-point";
import { nativeUserInteractableViewAtPointTool } from "../src/tools/native-devtools/native-user-interactable-view-at-point";
import { nativeProfilerSessionBlueprint } from "../src/blueprints/native-profiler-session";
import { nativeProfilerStartTool } from "../src/tools/profiler/native-profiler/native-profiler-start";
import { iosDeviceRunnerBlueprint } from "../src/blueprints/ios-device-runner";
import {
  clearCurrentIosDeviceApp,
  requireCurrentIosDeviceApp,
  setCurrentIosDeviceApp,
} from "../src/utils/ios-device/app-session";
import { createKeyboardTool } from "../src/tools/keyboard";
import { createFillTool } from "../src/tools/fill";
import { createScreenshotTool } from "../src/tools/screenshot";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { createLaunchAppTool } from "../src/tools/launch-app";
import { openUrlTool } from "../src/tools/open-url";
import { createRestartAppTool } from "../src/tools/restart-app";
import { reinstallAppTool } from "../src/tools/reinstall-app";

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
  // `native-devtools-status` runs the 2-arg precheck, so it has its own path to the refusal.
  const PRECHECKED_READS = TOOLS.filter(([tool]) => tool !== nativeDevtoolsStatusTool).map(
    ([tool, extra]) => [tool.id, extra] as const
  );
  let registry: Registry | undefined;

  function nativeApp() {
    __primeDepCacheForTests(["xcrun"]);
    registry = new Registry();
    registry.registerBlueprint(nativeDevtoolsBlueprint);
    for (const [tool] of TOOLS) registry.registerTool(tool as never);
    return createHttpApp(registry).app;
  }

  // The shape the promisified execFile resolves with, for the app-state reads.
  function answerWithEmptyOutput() {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, out?: unknown) => void;
      cb(null, { stdout: "", stderr: "" });
    });
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
    answerWithEmptyOutput();
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

  // `ensureEnvReady` latches once the simulator is armed, so the first simctl call
  // left for an unconnected app is the env re-apply inside `appConnectionState`.
  it.each(PRECHECKED_READS)(
    "%s answers 424 on a service that armed the simulator before the install went pending",
    async (id, extra) => {
      answerWithEmptyOutput();
      const app = nativeApp();
      const call = () =>
        request(app)
          .post(`/tools/${id}`)
          .send({ udid: SIM.id, bundleId: BUNDLE_ID, ...extra });
      expect((await call()).body.data.status).toBe("restart_required");

      pending.simctl = true;
      execFileMock.mockClear();
      const res = await call();

      // Read as an unmeasured app, it answered 200 restart_required, which says to
      // restart the app and then the tool-server.
      expect(res.status).toBe(424);
      expect(res.body.error).toMatch(/-runFirstLaunch/);
      expect(res.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
      expect(xcrunCalls()).toEqual([]);
    }
  );

  // A failed re-apply stays on record, and the reboot it prescribes cannot help here.
  it("answers the refusal rather than a failure recorded earlier", async () => {
    answerWithEmptyOutput();
    const instance = await nativeDevtoolsBlueprint.factory({}, SIM, { device: SIM });
    try {
      execFileMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error | null) => void;
        cb(new Error("Invalid device"));
      });
      await expect(instance.api.reverifyEnv()).rejects.toThrow("Invalid device");
      expect(instance.api.getInitFailure()).not.toBeNull();

      pending.simctl = true;
      await expect(precheckNativeDevtools(instance.api, SIM.id, BUNDLE_ID)).rejects.toBeInstanceOf(
        XcodeFirstLaunchPendingError
      );
    } finally {
      await instance.dispose();
    }
  });

  // The app answers these over its own socket, so a refusal here would take away
  // reads that do not need simctl.
  it.each(PRECHECKED_READS)("%s keeps serving an app that is connected", async (id, extra) => {
    const device: DeviceInfo = { ...SIM, id: "FA1E1722-0000-4000-8000-000000000002" };
    answerWithEmptyOutput();
    const app = nativeApp();
    const ref = nativeDevtoolsRef(device);
    const api = await registry!.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
    expect(api.isEnvSetup()).toBe(true);

    const agent = net.createConnection(api.socketPath, () => {
      agent.write(JSON.stringify({ type: "Control", payload: { bundleId: BUNDLE_ID } }) + "\n");
    });
    readline.createInterface({ input: agent }).on("line", (line) => {
      const { type, payload } = JSON.parse(line);
      if (type !== "ViewInspector") return;
      const result = { screenFrame: { x: 0, y: 0, width: 1, height: 1 }, elements: [] };
      agent.write(JSON.stringify({ type, payload: { id: payload.id, result } }) + "\n");
    });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE_ID)).toBe(true));

    pending.simctl = true;
    execFileMock.mockClear();
    await expect(precheckNativeDevtools(api, device.id, BUNDLE_ID)).resolves.toBeNull();
    const res = await request(app)
      .post(`/tools/${id}`)
      .send({ udid: device.id, bundleId: BUNDLE_ID, ...extra });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ok");
    expect(xcrunCalls()).toEqual([]);
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

  // Many of its tools only talk to the runner, so devicectl is refused where it is called.
  it("passes a physical iPhone while either install is pending", async () => {
    pending.simctl = true;
    pending.devicectl = true;
    await expect(ensureIosDeps(IPHONE, ["xcrun"])).resolves.toBeUndefined();
  });

  it("leaves a branch that does not run xcrun alone", async () => {
    pending.simctl = true;
    pending.devicectl = true;
    await expect(ensureIosDeps(SIMULATOR, [])).resolves.toBeUndefined();
  });

  it.each([
    ["simulator", SIMULATOR],
    ["physical iPhone", IPHONE],
  ])("names a missing xcrun before a pending install on a %s", async (_name, device) => {
    pending.simctl = true;
    pending.devicectl = true;
    __resetDepCacheForTests();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(new Error("not found"));
    });
    const err = await ensureIosDeps(device, ["xcrun"]).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(XcodeFirstLaunchPendingError);
    expect((err as Error).message).toMatch(/xcode-select --install/);
  });
});

describe("the local iOS preflight where tools call it", () => {
  beforeEach(() => __primeDepCacheForTests(["xcrun"]));

  function iosRegistry() {
    const registry = new Registry();
    registry.registerBlueprint(axServiceBlueprint);
    registry.registerBlueprint(nativeDevtoolsBlueprint);
    return registry;
  }

  // Without it, both poll for their whole timeout and then blame the simulator.
  it("makes await-ui-element refuse a simulator at once", async () => {
    pending.simctl = true;
    const tool = createAwaitUiElementTool(iosRegistry());
    const params = {
      udid: SIMULATOR.id,
      condition: "exists",
      selector: { text: "Done" },
      timeoutMs: 300,
    };
    await expect(tool.execute({}, params as never)).rejects.toBeInstanceOf(
      XcodeFirstLaunchPendingError
    );
    expect(xcrunCalls()).toEqual([]);
  });

  it("makes await-screen-idle refuse a simulator at once", async () => {
    pending.simctl = true;
    const tool = createAwaitScreenIdleTool(iosRegistry());
    await expect(
      tool.execute({}, { udid: SIMULATOR.id, timeoutMs: 300 } as never)
    ).rejects.toBeInstanceOf(XcodeFirstLaunchPendingError);
    expect(xcrunCalls()).toEqual([]);
  });

  function probeTool(handler: () => Promise<string>) {
    const capability: ToolCapability = { apple: { simulator: true, device: true } };
    return dispatchByPlatform<
      Record<string, never>,
      Record<string, never>,
      { udid: string },
      string
    >({
      toolId: "probe",
      capability,
      ios: { requires: ["xcrun"], handler },
      android: { requires: [], handler },
      iosDevice: { requires: ["xcrun"], handler },
    });
  }

  it("runs a physical iPhone's handler while the devicectl install is pending", async () => {
    pending.devicectl = true;
    const handler = vi.fn().mockResolvedValue("ran");
    await expect(probeTool(handler)({}, { udid: IPHONE.id })).resolves.toBe("ran");
    expect(handler).toHaveBeenCalledOnce();
  });

  // simctlPrefix refuses too, so only the handler shows the preflight ran.
  it("refuses a simulator's branch before its handler runs", async () => {
    pending.simctl = true;
    const handler = vi.fn().mockResolvedValue("ran");
    await expect(probeTool(handler)({}, { udid: SIMULATOR.id })).rejects.toBeInstanceOf(
      XcodeFirstLaunchPendingError
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("covers the device-type listing that tells foldables apart", async () => {
    pending.simctl = true;
    // A type no earlier listing knew, so neither cache can answer.
    await expect(
      isFoldableDeviceType("com.apple.CoreSimulator.SimDeviceType.FA1E1721-Unseen")
    ).resolves.toBe(false);
    expect(xcrunCalls()).toEqual([]);
  });
});

describe("a physical iPhone while only the devicectl install is pending", () => {
  const BUNDLE_ID = "com.example.app";
  const REFUSAL_CODE = FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING;
  const rect = { x: 0, y: 0, width: 390, height: 844 };
  const blank = { identifier: null, value: null, enabled: true, focused: null, selected: null };
  // What the runner answers for a snapshot: an app with one button.
  const SCREEN = [
    { ...blank, index: 0, depth: 0, parentIndex: null, type: "Application", label: null, rect },
    { ...blank, index: 1, depth: 1, parentIndex: 0, type: "Button", label: "Done", rect },
  ];
  let registry: Registry | undefined;

  function appWith(register: (registry: Registry) => void) {
    registry = new Registry();
    register(registry);
    return createHttpApp(registry).app;
  }

  beforeEach(() => {
    pending.devicectl = true;
    __primeDepCacheForTests(["xcrun"]);
    setCurrentIosDeviceApp(IPHONE.id, BUNDLE_ID);
  });

  afterEach(async () => {
    clearCurrentIosDeviceApp(IPHONE.id);
    await registry?.dispose();
    registry = undefined;
  });

  describe("with the runner up", () => {
    // The runner is already running, so nothing here starts it through devicectl.
    function runnerUp() {
      const run = vi.fn(async ({ command }: { command: string }) =>
        command === "snapshot" ? { nodes: SCREEN } : {}
      );
      const app = appWith((registry) => {
        registry.registerBlueprint({
          ...iosDeviceRunnerBlueprint,
          factory: async () => ({
            api: { udid: IPHONE.id, run },
            events: new TypedEventEmitter<ServiceEvents>(),
            dispose: async () => {},
          }),
        });
        registry.registerTool(createKeyboardTool(registry) as never);
        registry.registerTool(createDescribeTool(registry) as never);
        registry.registerTool(createFillTool(registry) as never);
        registry.registerTool(createAwaitUiElementTool(registry) as never);
        registry.registerTool(createAwaitScreenIdleTool(registry) as never);
      });
      return { app, run };
    }

    it.each([
      ["keyboard", { text: "hi" }, { typed: "hi", keys: 2 }],
      ["describe", {}, { description: expect.stringContaining("Done") }],
      ["fill", { text: "hi" }, { verified: false }],
      [
        "await-ui-element",
        { condition: "exists", selector: { text: "Done" }, timeoutMs: 5_000 },
        { success: true },
      ],
      ["await-screen-idle", { minStableMs: 0, timeoutMs: 5_000 }, { settled: true }],
    ])("%s keeps working, since it only talks to the runner", async (id, params, answer) => {
      const { app, run } = runnerUp();
      const res = await request(app)
        .post(`/tools/${id}`)
        .send({ udid: IPHONE.id, ...params });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject(answer);
      expect(run).toHaveBeenCalled();
      expect(xcrunCalls()).toEqual([]);
    });
  });

  // Starting the runner needs devicectl, so a tool that only talks to it is refused
  // from inside the service factory, wrapped twice on the way out.
  describe("with the runner down", () => {
    it.each([
      ["gesture-tap", { x: 0.5, y: 0.5 }],
      ["screenshot", {}],
      ["keyboard", { text: "hi" }],
      ["describe", {}],
      ["fill", { text: "hi" }],
      // Waiting cannot end the refusal, so these answer at once, not at their timeout.
      ["await-ui-element", { condition: "exists", selector: { text: "Done" }, timeoutMs: 5_000 }],
      ["await-screen-idle", { minStableMs: 0, timeoutMs: 5_000 }],
    ])("%s answers the refusal and is counted as the pending install", async (id, params) => {
      const app = appWith((registry) => {
        registry.registerBlueprint(iosDeviceRunnerBlueprint);
        registry.registerTool(gestureTapTool as never);
        registry.registerTool(createScreenshotTool(registry) as never);
        registry.registerTool(createKeyboardTool(registry) as never);
        registry.registerTool(createDescribeTool(registry) as never);
        registry.registerTool(createFillTool(registry) as never);
        registry.registerTool(createAwaitUiElementTool(registry) as never);
        registry.registerTool(createAwaitScreenIdleTool(registry) as never);
      });
      const res = await request(app)
        .post(`/tools/${id}`)
        .send({ udid: IPHONE.id, ...params });

      expect(res.status).toBe(424);
      expect(res.body.error).toMatch(/^The Xcode|^Xcode/);
      expect(res.body.error).toMatch(/-runFirstLaunch/);
      expect(res.body.error_code).toBe(REFUSAL_CODE);
      expect(res.body.missing).toEqual(["xcrun"]);
      expect(xcrunCalls()).toEqual([]);
    });
  });

  describe("a tool that needs devicectl", () => {
    let appPath: string;

    function appWithDevicectlTools() {
      return appWith((registry) => {
        registry.registerTool(createLaunchAppTool(registry) as never);
        registry.registerTool(openUrlTool as never);
        registry.registerTool(createRestartAppTool(registry) as never);
        registry.registerTool(reinstallAppTool as never);
      });
    }

    const TOOLS = [
      ["launch-app", () => ({ bundleId: BUNDLE_ID })],
      ["open-url", () => ({ url: "https://example.com" })],
      ["restart-app", () => ({ bundleId: BUNDLE_ID })],
      ["reinstall-app", () => ({ bundleId: BUNDLE_ID, appPath })],
    ] as const;

    function expectRefusal(res: request.Response) {
      expect(res.status).toBe(424);
      expect(res.body.error).toMatch(/`devicectl` waits .* does not show physical iPhones/);
      expect(res.body.error).toMatch(/-runFirstLaunch/);
      expect(res.body.error_code).toBe(REFUSAL_CODE);
      expect(xcrunCalls()).toEqual([]);
    }

    beforeEach(() => {
      // reinstall-app reads the bundle id of a real .app before it touches the device.
      appPath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "argent-first-launch-")),
        "App.app"
      );
      fs.mkdirSync(appPath);
      fs.writeFileSync(path.join(appPath, "Info.plist"), "");
      execFileMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error | null, out?: unknown) => void;
        cb(null, { stdout: args[0] === "plutil" ? BUNDLE_ID : "", stderr: "" });
      });
    });

    afterEach(() => {
      fs.rmSync(path.dirname(appPath), { recursive: true, force: true });
    });

    it.each(TOOLS)("%s answers the refusal and spawns no xcrun", async (id, params) => {
      const res = await request(appWithDevicectlTools())
        .post(`/tools/${id}`)
        .send({ udid: IPHONE.id, ...params() });
      expectRefusal(res);
    });

    // Right after another call the readiness check answers from its memo, so the
    // next devicectl call is the one that refuses. For reinstall-app that is the
    // uninstall, whose catch must not read the refusal as a missing app.
    it.each(TOOLS)("%s answers the refusal when the device was just ready", async (id, params) => {
      const udid = "00008110-00097854029000AA";
      pending.devicectl = false;
      await ensureDeviceReady(udid);
      pending.devicectl = true;
      setCurrentIosDeviceApp(udid, BUNDLE_ID);
      execFileMock.mockClear();

      const res = await request(appWithDevicectlTools())
        .post(`/tools/${id}`)
        .send({ udid, ...params() });

      expectRefusal(res);
      // reinstall-app forgets the app once the uninstall has run, so it did not.
      expect(requireCurrentIosDeviceApp(udid)).toBe(BUNDLE_ID);
      clearCurrentIosDeviceApp(udid);
    });
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
