/**
 * Issue #1523: while Xcode's component install is pending, no `simctl` call may
 * reach its wrapper, since each one would start the install and leave another
 * administrator-password request behind. The refusal must reach the agent as a
 * 424 that says what to do.
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  ArtifactStore,
  FAILURE_CODES,
  getFailureSignal,
  Registry,
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceEvents,
} from "@argent/registry";

const pending = vi.hoisted(() => ({ value: false }));
const additionalSets = vi.hoisted(() => ({ value: [] as string[] }));

vi.mock("../src/utils/xcode-first-launch", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/xcode-first-launch")>(
    "../src/utils/xcode-first-launch"
  );
  return { ...actual, xcodeFirstLaunchPending: () => pending.value };
});

// The suite-wide setup file replaces this module, and it is one of the call sites here.
vi.unmock("../src/utils/status-bar");

vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, getAdditionalIosDeviceSets: () => additionalSets.value };
});

const execFileMock = vi.fn();
// Real unless a case fakes the simulator-server process.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawnMock.mockImplementation(actual.spawn);
  return {
    ...actual,
    execFile: (...args: unknown[]) => execFileMock(...args),
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

// A gesture's touches, which reach a simulator-server over its WebSocket.
const sendCommandMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: sendCommandMock,
}));

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
import {
  __resetSimulatorRuntimeKindCacheForTesting,
  cacheSimulatorRuntimeKind,
  isFoldableDeviceType,
  listIosSimulators,
} from "../src/utils/ios-devices";
import {
  __resetExternalDeviceCacheForTesting,
  makeExternalId,
} from "../src/utils/external-devices";
import {
  simulatorServerBlueprint,
  simulatorServerRef,
  type SimulatorServerApi,
} from "../src/blueprints/simulator-server";
import { tvControlBlueprint } from "../src/blueprints/tv-control";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { createTvRemoteTool } from "../src/tools/tv-remote";
import { executeScreenshotDiffTool } from "../src/tools/screenshot-diff";
import { summaryReportsDimensionMismatch } from "../src/tools/screenshot-diff/screenshot-diff-summary";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import {
  __resetDeviceSetCacheForTesting,
  cachedDeviceSetForUdid,
  simctlArgsForUdid,
  simctlPrefix,
} from "../src/utils/ios-device-sets";
import { createDescribeTool } from "../src/tools/describe";
import { createForegroundAppTool } from "../src/tools/foreground-app";
import { createUiTreeTool } from "../src/tools/ui-tree";
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
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { createLaunchAppTool } from "../src/tools/launch-app";
import { openUrlTool } from "../src/tools/open-url";
import { createRestartAppTool } from "../src/tools/restart-app";
import { reinstallAppTool } from "../src/tools/reinstall-app";
import { settingsPermissionsTool } from "../src/tools/settings-permissions";
import { ensureAutomationEnabled, isEntitlementBypassActive } from "../src/utils/ax-prefs";
import { pinStatusBar, restoreStatusBar } from "../src/utils/status-bar";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const realPlatform = process.platform;
const SIMULATOR: DeviceInfo = {
  id: processScopedUdid("-1523-4523-8523-000000000000"),
  platform: "ios",
  kind: "simulator",
};

function xcrunCalls(): unknown[][] {
  return execFileMock.mock.calls.filter(([cmd]) => cmd === "xcrun");
}

beforeEach(() => {
  pending.value = false;
  additionalSets.value = [];
  execFileMock.mockReset();
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
    cb(null, "");
  });
  __resetDepCacheForTests();
  __resetDeviceSetCacheForTesting();
  __resetSimulatorRuntimeKindCacheForTesting();
  // boot-device refuses an iOS target off macOS before it reaches simctl.
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("the refusal", () => {
  it("is counted apart from a missing xcrun in failure telemetry", () => {
    expect(getFailureSignal(new XcodeFirstLaunchPendingError())).toMatchObject({
      error_code: FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING,
      failure_stage: "xcode_first_launch_check",
      error_kind: "dependency_missing",
    });
  });
});

describe("simctl argv while Xcode's install is pending", () => {
  it("is refused at the builder every simctl call goes through", () => {
    pending.value = true;
    expect(() => simctlPrefix(null)).toThrow(XcodeFirstLaunchPendingError);
    expect(() => simctlPrefix("/sets/radon")).toThrow(/-runFirstLaunch/);
  });

  it("is built as before once the install is done", () => {
    expect(simctlPrefix(null)).toEqual(["simctl"]);
    expect(simctlPrefix("/sets/radon")).toEqual(["simctl", "--set", "/sets/radon"]);
  });

  // Finding the set takes simctl too, so nothing can be learned while it is refused.
  it("is refused for a device in an additional set, whose set is found after the install", async () => {
    const radon = fs.mkdtempSync(path.join(os.tmpdir(), "argent-first-launch-"));
    additionalSets.value = [radon];
    try {
      pending.value = true;
      await expect(simctlArgsForUdid(SIMULATOR.id, ["boot", SIMULATOR.id])).rejects.toBeInstanceOf(
        XcodeFirstLaunchPendingError
      );
      expect(cachedDeviceSetForUdid(SIMULATOR.id)).toBeNull();
      expect(xcrunCalls()).toEqual([]);

      pending.value = false;
      execFileMock.mockImplementation((...args: unknown[]) => {
        const argv = args[1] as string[];
        const devices = argv[1] === "--set" ? [{ udid: SIMULATOR.id }] : [];
        const cb = args[args.length - 1] as (
          err: Error | null,
          out?: { stdout: string; stderr: string }
        ) => void;
        cb(null, { stdout: JSON.stringify({ devices: { runtime: devices } }), stderr: "" });
      });
      await expect(simctlArgsForUdid(SIMULATOR.id, ["boot", SIMULATOR.id])).resolves.toEqual([
        "simctl",
        "--set",
        radon,
        "boot",
        SIMULATOR.id,
      ]);
    } finally {
      fs.rmSync(radon, { recursive: true, force: true });
    }
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

  // A type read before the install went pending is remembered, so describe goes
  // on to start the accessibility service, and that start is refused.
  it.each([
    ["whose type the server has not read", undefined],
    ["whose type the server read before", "mobile" as const],
  ])("answers 424 with what to do, and spawns no xcrun, for a simulator %s", async (_, kind) => {
    cacheSimulatorRuntimeKind(SIMULATOR.id, kind);
    pending.value = true;
    const res = await request(describeApp()).post("/tools/describe").send({ udid: SIMULATOR.id });

    // Swallowed, this is an empty tree whose hint prescribes a reboot.
    expect(res.status).toBe(424);
    expect(res.body.error).toMatch(/open (that )?Xcode once/);
    expect(res.body.error).toMatch(/-runFirstLaunch/);
    expect(res.body.missing).toEqual(["xcrun"]);
    expect(xcrunCalls()).toEqual([]);
  });
});

describe("a tool that runs simctl while Xcode's install is pending", () => {
  const BUNDLE_ID = "com.example.app";
  let appPath: string;

  function tools() {
    __primeDepCacheForTests(["xcrun"]);
    const registry = new Registry();
    registry.registerBlueprint(nativeDevtoolsBlueprint);
    registry.registerTool(createBootDeviceTool(registry) as never);
    registry.registerTool(createLaunchAppTool(registry) as never);
    registry.registerTool(openUrlTool as never);
    registry.registerTool(createRestartAppTool(registry) as never);
    registry.registerTool(reinstallAppTool as never);
    registry.registerTool(settingsPermissionsTool as never);
    return registry;
  }

  function app() {
    return createHttpApp(tools()).app;
  }

  // Armed while the install was done, so launch-app and restart-app pass the
  // native-devtools precheck, which then runs no simctl, and reach `simctl launch`.
  async function armedTools() {
    pending.value = false;
    const registry = tools();
    const ref = nativeDevtoolsRef(SIMULATOR);
    const api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
    expect(api.isEnvSetup()).toBe(true);
    return registry;
  }

  // Each tool wraps a failed `simctl` call in its own error.
  const WRAPPING = [
    ["launch-app", { bundleId: BUNDLE_ID }, FAILURE_CODES.IOS_LAUNCH_SIMCTL_FAILED, "launch"],
    ["restart-app", { bundleId: BUNDLE_ID }, FAILURE_CODES.IOS_RESTART_LAUNCH_FAILED, "launch"],
    ["open-url", { url: "https://example.com" }, FAILURE_CODES.IOS_OPEN_URL_FAILED, "openurl"],
    [
      "settings-permissions",
      { action: "grant", permission: "camera", bundleId: BUNDLE_ID },
      FAILURE_CODES.IOS_SETTINGS_PERMISSION_FAILED,
      "privacy",
    ],
  ] as const;

  beforeEach(() => {
    // reinstall-app reads the bundle id of a real .app before it touches the device.
    appPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "argent-first-launch-")), "App.app");
    fs.mkdirSync(appPath);
    fs.writeFileSync(path.join(appPath, "Info.plist"), "");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, out?: unknown) => void;
      cb(null, { stdout: args[0] === "plutil" ? BUNDLE_ID : "", stderr: "" });
    });
    pending.value = true;
  });

  afterEach(() => {
    fs.rmSync(path.dirname(appPath), { recursive: true, force: true });
  });

  it.each([
    ["boot-device", () => ({})],
    ["launch-app", () => ({ bundleId: BUNDLE_ID })],
    ["open-url", () => ({ url: "https://example.com" })],
    ["restart-app", () => ({ bundleId: BUNDLE_ID })],
    ["reinstall-app", () => ({ bundleId: BUNDLE_ID, appPath })],
    [
      "settings-permissions",
      () => ({ action: "grant", permission: "contacts", bundleId: BUNDLE_ID }),
    ],
  ] as const)("%s answers the refusal and spawns no xcrun", async (id, params) => {
    const res = await request(app())
      .post(`/tools/${id}`)
      .send({ udid: SIMULATOR.id, ...params() });

    expect(res.status).toBe(424);
    expect(res.body.error).toMatch(/-runFirstLaunch/);
    expect(res.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
    expect(xcrunCalls()).toEqual([]);
  });

  // A flow step's reason is the message of the error the tool throws, and nothing
  // under it, so a tool's own wrapper would leave the agent without the fix.
  it.each(WRAPPING)(
    "%s throws the refusal itself on a service armed before the install went pending",
    async (id, params) => {
      const registry = await armedTools();
      try {
        pending.value = true;
        execFileMock.mockClear();
        const err = await registry
          .invokeTool(id, { udid: SIMULATOR.id, ...params })
          .catch((e: unknown) => e);

        expect((err as Error).message).toBe(
          `[Tool:${id}] ${new XcodeFirstLaunchPendingError().message}`
        );
        expect(getFailureSignal(err)?.error_code).toBe(
          FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING
        );
        expect(xcrunCalls()).toEqual([]);
      } finally {
        await registry.dispose();
      }
    }
  );

  it.each(WRAPPING)("%s still wraps any other simctl failure", async (id, params, code, verb) => {
    const registry = await armedTools();
    try {
      execFileMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error | null, out?: unknown) => void;
        const failed = args[0] === "xcrun" && (args[1] as string[]).includes(verb);
        cb(failed ? new Error("simctl failed") : null, { stdout: "", stderr: "" });
      });
      const err = await registry
        .invokeTool(id, { udid: SIMULATOR.id, ...params })
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/^\[Tool:[a-z-]+\] Failed to /);
      expect(getFailureSignal(err)?.error_code).toBe(code);
    } finally {
      await registry.dispose();
    }
  });

  it("the status bar and accessibility helpers spawn no xcrun", async () => {
    await expect(pinStatusBar(SIMULATOR)).resolves.toBe(false);
    await expect(restoreStatusBar(SIMULATOR)).resolves.toBe(false);
    await expect(ensureAutomationEnabled(SIMULATOR.id)).rejects.toBeInstanceOf(
      XcodeFirstLaunchPendingError
    );
    await expect(isEntitlementBypassActive(SIMULATOR.id)).resolves.toBe(false);
    expect(xcrunCalls()).toEqual([]);
  });
});

describe("a native-devtools tool while Xcode's install is pending", () => {
  // Its own UDID, so the service's unix socket is not another test file's.
  const SIM: DeviceInfo = {
    id: processScopedUdid("-1523-4000-8000-000000000001"),
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
      pending.value = true;
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
    pending.value = true;
    const app = nativeApp();
    const status = () =>
      request(app)
        .post("/tools/native-devtools-status")
        .send({ udid: SIM.id, bundleId: BUNDLE_ID });
    for (let call = 0; call < 4; call++) expect((await status()).status).toBe(424);

    pending.value = false;
    answerWithEmptyOutput();
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body.data.status).not.toBe("init_failed");
    expect(res.body.data.envSetup).toBe(true);
  });

  it("does not count a refusal as a failed start of the service", async () => {
    pending.value = true;
    const instance = await nativeDevtoolsBlueprint.factory({}, SIM, { device: SIM });
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        await expect(precheckNativeDevtools(instance.api, SIM.id)).rejects.toBeInstanceOf(
          XcodeFirstLaunchPendingError
        );
      }
      expect(instance.api.getInitFailure()).toBeNull();

      pending.value = false;
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

      pending.value = true;
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

      pending.value = true;
      await expect(precheckNativeDevtools(instance.api, SIM.id, BUNDLE_ID)).rejects.toBeInstanceOf(
        XcodeFirstLaunchPendingError
      );
    } finally {
      await instance.dispose();
    }
  });

  // `native-devtools-status` measures the app itself, and its fallback prefers a
  // recorded failure. A system app takes its own branch to the same fallback.
  it.each([
    ["an app under test", BUNDLE_ID],
    ["an Apple system app", "com.apple.Preferences"],
  ])(
    "native-devtools-status answers the refusal rather than a failure recorded earlier, for %s",
    async (_name, bundleId) => {
      answerWithEmptyOutput();
      const app = nativeApp();
      const ref = nativeDevtoolsRef(SIM);
      const api = await registry!.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
      expect(api.isEnvSetup()).toBe(true);

      execFileMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error | null) => void;
        cb(new Error("Invalid device"));
      });
      await expect(api.reverifyEnv()).rejects.toThrow("Invalid device");
      expect(api.getInitFailure()).not.toBeNull();

      pending.value = true;
      const res = await request(app)
        .post("/tools/native-devtools-status")
        .send({ udid: SIM.id, bundleId });

      expect(res.status).toBe(424);
      expect(res.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
    }
  );

  it("native-devtools-status keeps answering for an app that is connected", async () => {
    const device: DeviceInfo = { ...SIM, id: processScopedUdid("-1523-4000-8000-000000000003") };
    answerWithEmptyOutput();
    const app = nativeApp();
    const ref = nativeDevtoolsRef(device);
    const api = await registry!.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
    const agent = net.createConnection(api.socketPath, () => {
      agent.write(JSON.stringify({ type: "Control", payload: { bundleId: BUNDLE_ID } }) + "\n");
    });
    await vi.waitFor(() => expect(api.isConnected(BUNDLE_ID)).toBe(true));

    pending.value = true;
    execFileMock.mockClear();
    const res = await request(app)
      .post("/tools/native-devtools-status")
      .send({ udid: device.id, bundleId: BUNDLE_ID });

    expect(res.status).toBe(200);
    expect(res.body.data.connected).toBe(true);
    expect(xcrunCalls()).toEqual([]);
    agent.destroy();
  });

  // The app answers these over its own socket, so a refusal here would take away
  // reads that do not need simctl.
  it.each(PRECHECKED_READS)("%s keeps serving an app that is connected", async (id, extra) => {
    const device: DeviceInfo = { ...SIM, id: processScopedUdid("-1523-4000-8000-000000000002") };
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

    pending.value = true;
    execFileMock.mockClear();
    await expect(precheckNativeDevtools(api, device.id, BUNDLE_ID)).resolves.toBeNull();
    const res = await request(app)
      .post(`/tools/${id}`)
      .send({ udid: device.id, bundleId: BUNDLE_ID, ...extra });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ok");
    expect(xcrunCalls()).toEqual([]);
  });

  // A server started during the outage arms nothing, but an app launched under an
  // earlier server's injection still dials this simulator's socket.
  it.each(PRECHECKED_READS)(
    "%s serves a connected app on a service created while the install was pending",
    async (id, extra) => {
      const device: DeviceInfo = { ...SIM, id: processScopedUdid("-1523-4000-8000-000000000004") };
      pending.value = true;
      const app = nativeApp();
      const ref = nativeDevtoolsRef(device);
      const api = await registry!.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
      expect(api.isEnvSetup()).toBe(false);

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

      execFileMock.mockClear();
      const res = await request(app)
        .post(`/tools/${id}`)
        .send({ udid: device.id, bundleId: BUNDLE_ID, ...extra });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("ok");
      expect(xcrunCalls()).toEqual([]);
      expect(api.getInitFailure()).toBeNull();
      agent.destroy();
    }
  );

  // Only the app asked about may skip the refusal: another app's socket says nothing about it.
  it.each(PRECHECKED_READS)(
    "%s answers the refusal for an app that is not connected while another app is",
    async (id, extra) => {
      const device: DeviceInfo = { ...SIM, id: processScopedUdid("-1523-4000-8000-000000000005") };
      pending.value = true;
      const app = nativeApp();
      const ref = nativeDevtoolsRef(device);
      const api = await registry!.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
      expect(api.isEnvSetup()).toBe(false);

      const agent = net.createConnection(api.socketPath, () => {
        agent.write(
          JSON.stringify({ type: "Control", payload: { bundleId: "com.other.app" } }) + "\n"
        );
      });
      await vi.waitFor(() => expect(api.isConnected("com.other.app")).toBe(true));

      execFileMock.mockClear();
      const res = await request(app)
        .post(`/tools/${id}`)
        .send({ udid: device.id, bundleId: BUNDLE_ID, ...extra });

      expect(res.status).toBe(424);
      expect(res.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
      expect(xcrunCalls()).toEqual([]);
      agent.destroy();
    }
  );
});

describe("native-profiler-start while Xcode's install is pending", () => {
  it.each([
    ["detecting the app", {}],
    ["given an app_process, rather than saying to launch the app", { app_process: "Probe" }],
    ["looking up an app to cold-launch", { app_process: "Probe", malloc_stack_logging: true }],
  ])("answers 424 %s", async (_case, params) => {
    // Only `xctrace --device` can cold-launch an app for malloc_stack_logging.
    if ("malloc_stack_logging" in params) vi.stubEnv("ARGENT_IOS_CAPTURE", "device");
    pending.value = true;
    __primeDepCacheForTests(["xcrun"]);
    const registry = new Registry();
    registry.registerBlueprint(nativeProfilerSessionBlueprint);
    registry.registerTool(nativeProfilerStartTool as never);
    try {
      const res = await request(createHttpApp(registry).app)
        .post("/tools/native-profiler-start")
        .send({ device_id: SIMULATOR.id, ...params });

      expect(res.status).toBe(424);
      expect(res.body.error).toMatch(/-runFirstLaunch/);
      expect(res.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
    } finally {
      vi.unstubAllEnvs();
      await registry.dispose();
    }
  });

  it("still answers that a recording is running, which needs no simctl", async () => {
    pending.value = true;
    __primeDepCacheForTests(["xcrun"]);
    const { api } = await nativeProfilerSessionBlueprint.factory({}, SIMULATOR, {
      device: SIMULATOR,
    });
    api.profilingActive = true;

    const err = await nativeProfilerStartTool
      .execute({ session: api }, { device_id: SIMULATOR.id })
      .catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_PROFILER_SESSION_ALREADY_RUNNING
    );
  });
});

describe("the wait tools while Xcode's install is pending", () => {
  beforeEach(() => {
    __primeDepCacheForTests(["xcrun"]);
    // Read before the outage; unread, the type lookup is refused before any polling.
    cacheSimulatorRuntimeKind(SIMULATOR.id, "mobile");
  });

  function iosRegistry() {
    const registry = new Registry();
    registry.registerBlueprint(axServiceBlueprint);
    registry.registerBlueprint(nativeDevtoolsBlueprint);
    return registry;
  }

  function isTheRefusal(err: unknown): boolean {
    return getFailureSignal(err)?.error_code === FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING;
  }

  // Far past this test's own timeout, so running it out would fail the test.
  const NEVER = 60_000;

  it("makes await-ui-element answer at once, not at its timeout", async () => {
    pending.value = true;
    const tool = createAwaitUiElementTool(iosRegistry());
    const params = {
      udid: SIMULATOR.id,
      condition: "exists",
      selector: { text: "Done" },
      timeoutMs: NEVER,
    };
    await expect(tool.execute({}, params as never)).rejects.toSatisfy(isTheRefusal);
    expect(xcrunCalls()).toEqual([]);
  });

  it("makes await-screen-idle answer at once, not at its timeout", async () => {
    pending.value = true;
    const tool = createAwaitScreenIdleTool(iosRegistry());
    await expect(
      tool.execute({}, { udid: SIMULATOR.id, timeoutMs: NEVER } as never)
    ).rejects.toSatisfy(isTheRefusal);
    expect(xcrunCalls()).toEqual([]);
  });

  it("covers the device-type listing that tells foldables apart", async () => {
    pending.value = true;
    // A type no earlier listing knew, so neither cache can answer.
    await expect(
      isFoldableDeviceType("com.apple.CoreSimulator.SimDeviceType.FA1E1523-Unseen")
    ).resolves.toBe(false);
    expect(xcrunCalls()).toEqual([]);
  });
});

// These read over sockets that are already up, so they do not need simctl. A
// refusal here would take the tree away from every action over MCP.
describe("a warm session while Xcode's install is pending", () => {
  const BUTTON = {
    label: "Done",
    traits: ["button"],
    frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
  };
  let registry: Registry | undefined;

  function warmApp(describe: () => Promise<unknown>) {
    __primeDepCacheForTests(["xcrun"]);
    // The tool that started the accessibility service read the simulator's type first.
    cacheSimulatorRuntimeKind(SIMULATOR.id, "mobile");
    const reg = new Registry();
    registry = reg;
    reg.registerBlueprint({
      ...axServiceBlueprint,
      factory: async () => ({
        api: {
          degraded: false,
          describe,
          tree: async () => ({
            alertVisible: false,
            screenFrame: { width: 100, height: 100 },
            nodes: [],
          }),
          foregroundApp: async () => ({ alertVisible: false, bundleId: "com.example.app" }),
        },
        events: new TypedEventEmitter<ServiceEvents>(),
        dispose: async () => {},
      }),
    } as never);
    reg.registerBlueprint(nativeDevtoolsBlueprint);
    reg.registerTool(createDescribeTool(reg));
    reg.registerTool(createUiTreeTool(reg) as never);
    reg.registerTool(createForegroundAppTool(reg) as never);
    reg.registerTool(createAwaitUiElementTool(reg) as never);
    reg.registerTool(createAwaitScreenIdleTool(reg) as never);
    return createHttpApp(reg).app;
  }

  afterEach(async () => {
    await registry?.dispose();
    registry = undefined;
  });

  it.each([
    ["describe", {}, { description: expect.stringContaining("Done") }],
    ["ui-tree", {}, { source: "ax-service" }],
    ["foreground-app", {}, { bundleId: "com.example.app" }],
    [
      "await-ui-element",
      { condition: "exists", selector: { text: "Done" }, timeoutMs: 2_000 },
      { success: true },
    ],
    ["await-screen-idle", { minStableMs: 0, timeoutMs: 2_000 }, { settled: true }],
  ])("%s answers without a refusal or a simctl call", async (id, params, answer) => {
    pending.value = true;
    const app = warmApp(async () => ({ alertVisible: false, elements: [BUTTON] }));
    const res = await request(app)
      .post(`/tools/${id}`)
      .send({ udid: SIMULATOR.id, ...params });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject(answer);
    expect(xcrunCalls()).toEqual([]);
  });

  // An empty accessibility read falls back to measuring the app, which needs simctl.
  it("describe answers the refusal when the fallback's measurement is refused", async () => {
    pending.value = true;
    const app = warmApp(async () => ({ alertVisible: false, elements: [] }));
    const res = await request(app)
      .post("/tools/describe")
      .send({ udid: SIMULATOR.id, bundleId: "com.example.app" });

    // Read as an unmeasured app, it answered 200 with should_restart.
    expect(res.status).toBe(424);
    expect(res.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
    expect(xcrunCalls()).toEqual([]);
  });
});

// A simulator-server is built for the simulator's type: none for an Apple TV,
// and one that names its panels for a foldable. A server built on a guess would
// stay wrong after the install.
describe("a simulator-server while Xcode's install is pending", () => {
  const SIMS = {
    tv: processScopedUdid("-1763-4000-8000-00000000000A"),
    foldable: processScopedUdid("-1763-4000-8000-00000000000B"),
    iphone: processScopedUdid("-1763-4000-8000-00000000000C"),
  };
  const DEVICE_TYPES = {
    [SIMS.tv]: "Apple-TV-4K",
    [SIMS.foldable]: "iPhone-Duo",
    [SIMS.iphone]: "iPhone-17",
  };
  const PANELS = [
    { screenId: 1, width: 1398, height: 2034 },
    { screenId: 3, width: 2007, height: 2853 },
  ];
  const BINARY = "/fake/sim-server";
  const realFetch = globalThis.fetch;
  const realSpawn = spawnMock.getMockImplementation()!;
  let typesDir: string;
  let registry: Registry | undefined;

  const deviceType = (udid: string) =>
    `com.apple.CoreSimulator.SimDeviceType.${DEVICE_TYPES[udid]}`;
  const listed = (udid: string) => ({
    udid,
    name: DEVICE_TYPES[udid],
    state: "Booted",
    deviceTypeIdentifier: deviceType(udid),
    isAvailable: true,
  });

  beforeEach(() => {
    __primeDepCacheForTests(["xcrun"]);
    // The device-type profiles; the Duo's lists two integrated displays.
    typesDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-first-launch-types-"));
    for (const udid of Object.values(SIMS)) {
      const resources = path.join(typesDir, DEVICE_TYPES[udid]!, "Contents", "Resources");
      fs.mkdirSync(resources, { recursive: true });
      fs.writeFileSync(path.join(resources, "capabilities.plist"), "");
    }
    execFileMock.mockImplementation((...args: unknown[]) => {
      const [cmd, argv] = args as [string, string[]];
      const cb = args[args.length - 1] as (err: Error | null, out: object) => void;
      let stdout = "";
      if (cmd === "xcrun" && argv.includes("devices")) {
        stdout = JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.tvOS-26-5": [listed(SIMS.tv)],
            "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [
              listed(SIMS.foldable),
              listed(SIMS.iphone),
            ],
          },
        });
      } else if (cmd === "xcrun" && argv.includes("devicetypes")) {
        stdout = JSON.stringify({
          devicetypes: Object.values(SIMS).map((udid) => ({
            identifier: deviceType(udid),
            bundlePath: path.join(typesDir, DEVICE_TYPES[udid]!),
          })),
        });
      } else if (cmd === "plutil") {
        const panels = argv.at(-1)!.includes("iPhone-Duo") ? 2 : 1;
        stdout = JSON.stringify(Array(panels).fill({ displayType: "integrated" }));
      }
      cb(null, { stdout, stderr: "" });
    });
    spawnMock.mockImplementation((...args: unknown[]) =>
      args[0] === BINARY
        ? fakeSimulatorServer()
        : realSpawn(...(args as Parameters<typeof realSpawn>))
    );
    globalThis.fetch = vi.fn(async () =>
      Response.json({ foldable: true, panels: PANELS, hingeAngle: null })
    ) as unknown as typeof fetch;
    sendCommandMock.mockClear();
  });

  afterEach(async () => {
    await registry?.dispose();
    registry = undefined;
    spawnMock.mockImplementation(realSpawn);
    globalThis.fetch = realFetch;
    fs.rmSync(typesDir, { recursive: true, force: true });
  });

  /** A simulator-server process that is ready at once. */
  function fakeSimulatorServer() {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: { write: vi.fn() },
      kill: vi.fn(),
    });
    setImmediate(() =>
      proc.stdout.push("api_ready http://127.0.0.1:61900\nstream_ready http://127.0.0.1:61901\n")
    );
    return proc;
  }

  function app() {
    registry = new Registry();
    registry.registerBlueprint(simulatorServerBlueprint);
    registry.registerTool(gestureTapTool as never);
    return createHttpApp(registry).app;
  }

  const tap = (server: ReturnType<typeof app>, udid: string) =>
    request(server).post("/tools/gesture-tap").send({ udid, x: 0.5, y: 0.5 });

  const simulatorServersSpawned = () =>
    spawnMock.mock.calls.filter(([binary]) => binary === BINARY).length;

  async function displayOf(udid: string) {
    const ref = simulatorServerRef({ id: udid, platform: "ios", kind: "simulator" });
    return (await registry!.resolveService<SimulatorServerApi>(ref.urn, ref.options)).display;
  }

  it.each([
    [
      "an Apple TV",
      SIMS.tv,
      async (res: request.Response) => {
        expect(res.status).toBe(400);
        expect(res.body.error_code).toBe(FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION);
        expect(simulatorServersSpawned()).toBe(0);
      },
    ],
    [
      "a foldable",
      SIMS.foldable,
      async (res: request.Response) => {
        expect(res.status).toBe(200);
        expect(await displayOf(SIMS.foldable)).toMatchObject({ foldable: true, panels: PANELS });
      },
    ],
    // Its type would be guessed right, but nothing tells it from the other two.
    [
      "an iPhone",
      SIMS.iphone,
      async (res: request.Response) => {
        expect(res.status).toBe(200);
        expect(await displayOf(SIMS.iphone)).toBeUndefined();
      },
    ],
  ])(
    "refuses %s on a server that has not read its type, and builds the right server after the install",
    async (_name, udid, afterInstall) => {
      pending.value = true;
      const server = app();

      const refused = await tap(server, udid);
      expect(refused.status).toBe(424);
      expect(refused.body.error).toMatch(/-runFirstLaunch/);
      expect(refused.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
      expect(simulatorServersSpawned()).toBe(0);
      expect(xcrunCalls()).toEqual([]);

      pending.value = false;
      await afterInstall(await tap(server, udid));
    }
  );

  // A provider's simulator needs no simctl for a tap, but its type is read
  // under its `ext:` id, which no listing records.
  it("refuses a provider's simulator listed before the install went pending, and taps it after the install", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-first-launch-provider-"));
    const descriptor = path.join(dir, "acme.json");
    fs.writeFileSync(
      descriptor,
      JSON.stringify({
        devices: [
          {
            capabilities: ["simctl", "simulator-server"],
            kind: "simulator",
            name: "iPhone 17",
            nativeId: SIMS.iphone,
            platform: "ios",
            simulatorServer: {
              apiUrl: "http://127.0.0.1:61910",
              streamUrl: "http://127.0.0.1:61911",
            },
            state: "Booted",
          },
        ],
        id: "acme-3f2a9c",
        name: "Acme IDE",
        schemaVersion: 1,
      })
    );
    const savedDisable = process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
    delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
    process.env.ARGENT_DEVICE_PROVIDERS = descriptor;
    __resetExternalDeviceCacheForTesting();
    try {
      const id = makeExternalId("acme-3f2a9c", SIMS.iphone);
      const server = app();
      // What list-devices runs.
      await listIosSimulators();
      pending.value = true;
      execFileMock.mockClear();

      const refused = await tap(server, id);
      expect(refused.status).toBe(424);
      expect(refused.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
      expect(simulatorServersSpawned()).toBe(0);
      expect(xcrunCalls()).toEqual([]);

      pending.value = false;
      expect((await tap(server, id)).status).toBe(200);
      expect(simulatorServersSpawned()).toBe(0);
    } finally {
      delete process.env.ARGENT_DEVICE_PROVIDERS;
      if (savedDisable === undefined) delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
      else process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = savedDisable;
      __resetExternalDeviceCacheForTesting();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The tv-control service reads the type too, before it starts the Apple TV's
  // daemons.
  it("answers the reason to a tv-remote call on an Apple TV whose type it has not read", async () => {
    // Nothing may reach a real process here.
    spawnMock.mockImplementation(() => {
      throw new Error("no process may start here");
    });
    registry = new Registry();
    registry.registerBlueprint(tvControlBlueprint);
    registry.registerTool(createTvRemoteTool(registry) as never);
    pending.value = true;

    const res = await request(createHttpApp(registry).app)
      .post("/tools/tv-remote")
      .send({ udid: SIMS.tv, button: "select" });

    expect(res.status).toBe(424);
    expect(res.body.error).toMatch(/-runFirstLaunch/);
    expect(res.body.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
    expect(xcrunCalls()).toEqual([]);
  });

  it("keeps a simulator-server that is already up working", async () => {
    const server = app();
    expect((await tap(server, SIMS.foldable)).status).toBe(200);
    expect((await tap(server, SIMS.iphone)).status).toBe(200);
    expect((await tap(server, SIMS.tv)).status).toBe(400);
    const spawned = simulatorServersSpawned();

    pending.value = true;
    execFileMock.mockClear();
    sendCommandMock.mockClear();
    expect((await tap(server, SIMS.foldable)).status).toBe(200);
    expect((await tap(server, SIMS.iphone)).status).toBe(200);
    // Its type was read before, so it is still told what it is.
    expect((await tap(server, SIMS.tv)).body.error_code).toBe(
      FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION
    );
    expect(sendCommandMock).toHaveBeenCalledTimes(4);
    expect(simulatorServersSpawned()).toBe(spawned);
    expect(xcrunCalls()).toEqual([]);
    expect(await displayOf(SIMS.foldable)).toMatchObject({ foldable: true, panels: PANELS });
  });
});

// Two saved screenshots need no simulator. On a foldable, a size mismatch also
// names each posture, which needs its type.
describe("screenshot-diff while Xcode's install is pending", () => {
  it("compares two saved screenshots of a simulator whose type it cannot read", async () => {
    pending.value = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-first-launch-diff-"));
    try {
      const png = (width: number, height: number) => PNG.sync.write(new PNG({ width, height }));
      fs.writeFileSync(path.join(dir, "baseline.png"), png(2, 4));
      fs.writeFileSync(path.join(dir, "current.png"), png(4, 2));

      const result = await executeScreenshotDiffTool(
        {},
        {
          baselinePath: path.join(dir, "baseline.png"),
          currentPath: path.join(dir, "current.png"),
          udid: SIMULATOR.id,
          outputDir: dir,
        },
        { artifacts: new ArtifactStore() }
      );

      expect(summaryReportsDimensionMismatch(result.summary)).toBe(true);
      expect(result.summary).not.toContain("posture:");
      expect(xcrunCalls()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the ax-service factory while Xcode's install is pending", () => {
  const socketPath = `/tmp/ax-${SIMULATOR.id.slice(0, 8)}.sock`;
  const factory = () => axServiceBlueprint.factory({}, SIMULATOR, { device: SIMULATOR });

  it("is refused before it listens", async () => {
    pending.value = true;
    const listen = vi.spyOn(net.Server.prototype, "listen");
    try {
      await expect(factory()).rejects.toBeInstanceOf(XcodeFirstLaunchPendingError);
      expect(listen).not.toHaveBeenCalled();
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      listen.mockRestore();
    }
  });
});

// Some tools check for xcrun without ever running simctl, such as
// native-profiler-stop, which only signals xctrace and exports its trace.
describe("the plain dependency check", () => {
  it("does not look at Xcode's components", async () => {
    pending.value = true;
    __primeDepCacheForTests(["xcrun", "adb"]);
    await expect(ensureDeps(["xcrun"])).resolves.toBeUndefined();
    await expect(ensureDeps(["adb"])).resolves.toBeUndefined();
  });
});
