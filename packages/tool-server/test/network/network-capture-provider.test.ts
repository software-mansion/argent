import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Registry,
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import {
  forgetJsCapturesOf,
  networkInspectorBlueprint,
} from "../../src/blueprints/network-inspector";
import { createNetworkCaptureStartTool } from "../../src/tools/network/network-capture-start";
import { createNetworkCaptureStopTool } from "../../src/tools/network/network-capture-stop";
import type {
  CaptureResult,
  StartedLayer,
  StoppedLayer,
} from "../../src/tools/network/network-capture";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../../src/utils/check-deps";
import { resetDeviceAliases } from "../../src/utils/debugger/device-alias";
import {
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  makeExternalId,
} from "../../src/utils/external-devices";
import { readAppProcesses } from "../../src/blueprints/android-network-inspector-device";

/**
 * A provider lends a device and re-serves the one debugger connection React
 * Native admits for it. The capture tools name the device by its udid and, on
 * a Metro several devices share, its runtime by Metro's logicalDeviceId. No
 * provider claims a logicalDeviceId, so only the udid can find the provider's
 * grant and socket.
 */

const ANDROID_SERIAL = "emulator-5554";
const PROVIDER_ID = "acme-3f2a9c";
const EXT_ID = makeExternalId(PROVIDER_ID, ANDROID_SERIAL);
const METRO_PORT = 54321;
const APP = "com.example.shop";
/** The provider's device on Metro. */
const LOGICAL_ID = "logical-1";

const PROVIDER_SOCKET_URL = "ws://127.0.0.1:60999/argent-cdp";
/** What Argent dials for the target of LOGICAL_ID on a Metro of the default port. */
const METRO_DIALLED_URL = "ws://localhost:8081/inspector/debug?device=1&page=-1";

const dialled = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock("../../src/utils/debugger/cdp-client", () => ({
  CDPClient: class {
    events = { emit: () => {}, off: () => {}, on: () => {} };
    constructor(public readonly url: string) {
      dialled.urls.push(url);
    }
    addBinding = async () => {};
    connect = async () => {};
    disconnect = async () => {};
    evaluate = async () => undefined;
    isConnected = () => true;
    pausedAt = () => undefined;
    send = async () => ({});
  },
}));

/** Two devices share the provider's Metro, so only a logicalDeviceId picks a runtime. */
vi.mock("../../src/utils/debugger/discovery", () => ({
  discoverMetro: async (port: number) => ({
    port,
    projectRoot: "/Users/me/src/my-app",
    targets: [
      {
        description: "",
        deviceName: "Pixel 9",
        id: "1",
        reactNative: {
          capabilities: { prefersFuseboxFrontend: true },
          logicalDeviceId: "logical-1",
        },
        title: "com.example.shop",
        webSocketDebuggerUrl: `ws://10.0.2.2:${port}/inspector/debug?device=1&page=-1`,
      },
      {
        description: "",
        deviceName: "iPhone 17",
        id: "2",
        reactNative: {
          capabilities: { prefersFuseboxFrontend: true },
          logicalDeviceId: "logical-2",
        },
        title: "com.example.shop",
        webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=2&page=-1`,
      },
    ],
  }),
}));

// The app runs, so a stop that cannot reach its runtime does not report it ended.
vi.mock("../../src/blueprints/android-network-inspector-device", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/blueprints/android-network-inspector-device")
  >()),
  readAppProcesses: vi.fn(),
}));

/** The native layer is not under test: it arms and stops. */
const fakeAndroidInspectorBlueprint: ServiceBlueprint<unknown, string> = {
  namespace: "AndroidNetworkInspector",
  getURN: (payload) => `AndroidNetworkInspector:${payload}`,
  async factory() {
    let started = false;
    return {
      api: {
        startCapture: async () => ((started = true), { armed: true }),
        stopCapture: async () => ((started = false), { confirmed: true }),
        isStarted: () => started,
        isStopped: () => !started,
        captureMark: () => undefined,
        records: () => [],
      },
      dispose: async () => {},
      events: new TypedEventEmitter<ServiceEvents>(),
    };
  },
};

let temporaryDirectory: string;
let registry: Registry;

function publishDescriptor({ jsDebugger }: { jsDebugger: boolean }): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");
  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: [
        {
          capabilities: jsDebugger ? ["adb", "js-debugger"] : ["adb"],
          jsDebugger: { webSocketUrl: PROVIDER_SOCKET_URL },
          kind: "emulator",
          metroPort: METRO_PORT,
          name: "Pixel 9",
          nativeId: ANDROID_SERIAL,
          platform: "android",
          state: "device",
        },
      ],
      id: PROVIDER_ID,
      name: "Acme IDE",
      schemaVersion: 1,
    })
  );
  process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-capture-provider-"));
  dialled.urls.length = 0;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  __resetExternalDeviceCacheForTesting();
  __resetProviderWarningsForTesting();
  __primeDepCacheForTests(["adb"]);
  vi.mocked(readAppProcesses).mockResolvedValue({
    user: 0,
    processes: [{ pid: 4242, startTime: 1, user: 0 }],
  });
  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerBlueprint(networkInspectorBlueprint);
  registry.registerBlueprint(fakeAndroidInspectorBlueprint);
  registry.registerTool(createNetworkCaptureStartTool(registry));
  registry.registerTool(createNetworkCaptureStopTool(registry));
});

afterEach(async () => {
  await registry.dispose();
  forgetJsCapturesOf();
  resetDeviceAliases();
  __resetDepCacheForTests();
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
});

function start(udid: string) {
  return registry.invokeTool<CaptureResult<StartedLayer>>("network-capture-start", {
    udid,
    bundleId: APP,
    logicalDeviceId: LOGICAL_ID,
  });
}

function stop(udid: string) {
  return registry.invokeTool<CaptureResult<StoppedLayer>>("network-capture-stop", {
    udid,
    bundleId: APP,
    logicalDeviceId: LOGICAL_ID,
  });
}

function jsLayer<L extends { layer: string }>(result: CaptureResult<L>): L | undefined {
  return result.layers.find((l) => l.layer === "js");
}

/** The debugger the JS layer opened: the provider device's runtime, picked by its logicalDeviceId. */
async function openedDebugger(): Promise<{ deviceName: string; logicalDeviceId?: string }> {
  return registry.resolveService(`JsRuntimeDebugger:${METRO_PORT}:${LOGICAL_ID}`);
}

describe.each([
  { spelling: "ext: id", udid: EXT_ID },
  { spelling: "raw serial", udid: ANDROID_SERIAL },
])("a provider device named by its $spelling, with a logicalDeviceId", ({ udid }) => {
  it("starts capture through the provider's socket, on the runtime of its logicalDeviceId", async () => {
    publishDescriptor({ jsDebugger: true });

    await start(udid);

    expect(dialled.urls).toEqual([PROVIDER_SOCKET_URL]);
    expect(await openedDebugger()).toMatchObject({
      deviceName: "Pixel 9",
      logicalDeviceId: LOGICAL_ID,
    });
  });

  it("stops capture through the provider's socket on a fresh connection", async () => {
    publishDescriptor({ jsDebugger: true });

    await stop(udid);

    expect(dialled.urls).toEqual([PROVIDER_SOCKET_URL]);
    expect(await openedDebugger()).toMatchObject({
      deviceName: "Pixel 9",
      logicalDeviceId: LOGICAL_ID,
    });
  });

  it("does not start the JS layer when the provider did not grant js-debugger", async () => {
    publishDescriptor({ jsDebugger: false });

    const result = await start(udid);

    expect(dialled.urls).toEqual([]);
    expect(jsLayer(result)).toMatchObject({
      armed: false,
      unavailable: true,
      reason: expect.stringContaining("did not grant the 'js-debugger' capability"),
    });
  });

  it("does not reach the JS runtime on a stop when the provider did not grant js-debugger", async () => {
    publishDescriptor({ jsDebugger: false });

    const result = await stop(udid);

    expect(dialled.urls).toEqual([]);
    expect(jsLayer(result)?.reason).toContain("did not grant the 'js-debugger' capability");
  });
});

describe("a device argent booted itself, with a logicalDeviceId", () => {
  it("dials Metro's target of that logicalDeviceId", async () => {
    publishDescriptor({ jsDebugger: true });

    await start("emulator-5556");

    expect(dialled.urls).toEqual([METRO_DIALLED_URL]);
  });
});
