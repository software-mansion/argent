import { describe, it, expect, vi, beforeEach } from "vitest";
import * as net from "node:net";
import { FAILURE_CODES, getFailureSignal, Registry, type DeviceInfo } from "@argent/registry";

// Capture is started by network-capture-start, through the blueprint's
// startNetworkCapture, and delivered by the blueprint: straight away to a
// connected app, or at the handshake of one that connects later (the relaunch
// `restart_required` asks for). native-network-logs only reads. These run the
// real blueprint against a fake app on its socket, so dropping either half
// brings the lost-launch bug back here.

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

type ExecCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;

// Every simctl call succeeds with empty output, so `launchctl list` shows no
// running app and the precheck answers restart_required.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (_cmd: string, args: readonly string[], opts: unknown, cb?: ExecCb) => {
      const callback = (typeof opts === "function" ? opts : cb!) as ExecCb;
      const argv = args.join(" ");
      if (argv.includes("simctl list")) {
        callback(null, { stdout: JSON.stringify({ devices: {} }), stderr: "" });
        return;
      }
      callback(null, { stdout: "", stderr: "" });
    },
  };
});

import {
  nativeDevtoolsBlueprint,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../src/blueprints/native-devtools";
import { createNativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

const UDID = processScopedUdid("-5555-6666-7777-888888888888");
const BUNDLE = "com.example.app";
const device: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };
/** Whether a line the app was sent asks it to turn capture on. */
const isEnable = (line: string): boolean => {
  const frame = JSON.parse(line) as { type?: string; payload?: { method?: string } };
  return frame.type === "CDP" && frame.payload?.method === "Network.enable";
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

const NOT_STARTED = {
  status: "ok",
  header: `ios-native: not started, 0 requests (network capture is off for ${BUNDLE}; call network-capture-start for it, then repeat the action)`,
  armed: false,
  started: false,
  count: 0,
  total: 0,
  requests: [],
};

const STOPPED_DETAIL =
  "capture stopped by network-capture-stop; network-capture-start turns it on again";

/**
 * Dial the service as the injected dylib does, recording every line it is sent
 * and acknowledging each CDP request, Network.enable only with `answerEnable`.
 */
async function connectApp(
  socketPath: string,
  bundleId: string,
  { answerEnable = true }: { answerEnable?: boolean } = {}
) {
  const received: string[] = [];
  let buffer = "";
  const sock = net.createConnection(socketPath, () => {
    sock.write(JSON.stringify({ type: "Control", payload: { bundleId } }) + "\n");
  });
  sock.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    received.push(...lines);
    for (const line of lines) {
      const { type, payload } = JSON.parse(line) as {
        type: string;
        payload: { id?: number; method?: string };
      };
      if (type !== "CDP" || payload.id === undefined) continue;
      if (payload.method === "Network.enable" && !answerEnable) continue;
      sock.write(JSON.stringify({ type, payload: { id: payload.id, result: {} } }) + "\n");
    }
  });
  await settle();
  return {
    received,
    enables: () => received.filter(isEnable).length,
    /** Sends a CDP event, as the app does with its network events. */
    sendEvent: (method: string, params: Record<string, unknown>) =>
      sock.write(JSON.stringify({ type: "CDP", payload: { method, params } }) + "\n"),
    close: () => sock.destroy(),
  };
}

async function withService(run: (api: NativeDevtoolsApi) => Promise<void>) {
  const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
  try {
    await run(instance.api as NativeDevtoolsApi);
  } finally {
    await instance.dispose();
  }
}

/** A registry with the native-devtools blueprint and the tool, as the tool-server builds it. */
async function withRegistry(run: (registry: Registry) => Promise<void>) {
  const registry = new Registry();
  registry.registerBlueprint(nativeDevtoolsBlueprint);
  registry.registerTool(createNativeNetworkLogsTool(registry));
  try {
    await run(registry);
  } finally {
    await registry.dispose();
  }
}

const callTool = (api: NativeDevtoolsApi, bundleId = BUNDLE) =>
  nativeNetworkLogsTool.execute(
    { nativeDevtools: api },
    { udid: UDID, bundleId, limit: 50, clear: false }
  );

const headerOf = (result: unknown): string => (result as { header: string }).header;

/** Spies on what the precheck runs first, so a test can say no precheck ran. */
function watchPrecheck(api: NativeDevtoolsApi) {
  const ensureEnvReady = vi.spyOn(api, "ensureEnvReady");
  const appConnectionState = vi.spyOn(api, "appConnectionState");
  return () => [...ensureEnvReady.mock.calls, ...appConnectionState.mock.calls];
}

beforeEach(async () => {
  const { __resetDepCacheForTests, __primeDepCacheForTests } =
    await import("../src/utils/check-deps");
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun"]);
});

describe("native network capture started through the blueprint", () => {
  it("starts capture of a connected app, and the first read says it missed earlier requests", async () => {
    await withService(async (api) => {
      const app = await connectApp(api.socketPath, BUNDLE);

      await expect(api.startNetworkCapture(BUNDLE, 8081)).resolves.toBe(true);
      expect(app.enables()).toBe(1);

      const first = await callTool(api);
      expect(first).toMatchObject({ status: "ok", armed: true, count: 0 });
      expect(headerOf(first)).toMatch(/were not recorded.*restart-app/);

      // Capture was already on for the second read, so its count is the truth.
      const second = await callTool(api);
      expect(second).toMatchObject({ status: "ok" });
      expect(headerOf(second)).not.toMatch(/were not recorded/);
      // A read asks the app for nothing.
      await settle();
      expect(app.enables()).toBe(1);
      app.close();
    });
  });

  it("arms an app at its handshake after a start that found no process of it", async () => {
    await withService(async (api) => {
      await expect(api.startNetworkCapture(BUNDLE, 8081)).resolves.toBe(false);
      // The read only reports what the relaunch needs: the start already turned capture on.
      expect(await callTool(api)).toMatchObject({ status: "restart_required" });

      // The relaunch: capture must be on before the app sends its first request.
      const app = await connectApp(api.socketPath, BUNDLE);
      await vi.waitFor(() => expect(app.received.some(isEnable)).toBe(true));

      // That launch was captured, so the next answer carries no note.
      const next = await callTool(api);
      expect(next).toMatchObject({ status: "ok" });
      expect(headerOf(next)).not.toMatch(/were not recorded/);
      app.close();
    });
  });

  it("arms a started app again when it reconnects after restart-app", async () => {
    await withService(async (api) => {
      const before = await connectApp(api.socketPath, BUNDLE);
      await api.startNetworkCapture(BUNDLE, 8081);
      before.close();
      await settle();

      const after = await connectApp(api.socketPath, BUNDLE);
      await vi.waitFor(() => expect(after.received.some(isEnable)).toBe(true));
      after.close();
    });
  });

  it("drops the missed-launch note once a relaunch is captured from its handshake", async () => {
    await withService(async (api) => {
      const before = await connectApp(api.socketPath, BUNDLE);
      // Started while the app runs, so its launch was missed.
      await api.startNetworkCapture(BUNDLE, 8081);
      before.close();
      await settle();

      const after = await connectApp(api.socketPath, BUNDLE);
      await vi.waitFor(() => expect(after.received.some(isEnable)).toBe(true));

      const next = await callTool(api);
      expect(next).toMatchObject({ status: "ok" });
      expect(headerOf(next)).not.toMatch(/were not recorded/);
      after.close();
    });
  });

  it("never asks an Apple system app it refuses to capture", async () => {
    const SYSTEM_APP = "com.apple.Preferences";
    await withService(async (api) => {
      const connected = await connectApp(api.socketPath, SYSTEM_APP);

      const err = await callTool(api, SYSTEM_APP).catch((e: unknown) => e);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
      await settle();
      expect(connected.received.some(isEnable)).toBe(false);
      connected.close();
      await settle();

      // Nor at a later launch.
      const relaunched = await connectApp(api.socketPath, SYSTEM_APP);
      expect(relaunched.received.some(isEnable)).toBe(false);
      relaunched.close();
    });
  });
});

describe("native-network-logs only reads iOS capture", () => {
  it("answers not started before any start, with no precheck, while the watcher's service runs", async () => {
    await withRegistry(async (registry) => {
      const ref = nativeDevtoolsRef(device);
      // As the simulator watcher does for every booted simulator.
      const api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
      const app = await connectApp(api.socketPath, BUNDLE);
      const precheckCalls = watchPrecheck(api);

      const result = await registry.invokeTool("native-network-logs", {
        udid: UDID,
        bundleId: BUNDLE,
      });

      expect(result).toEqual(NOT_STARTED);
      expect(precheckCalls()).toEqual([]);
      await settle();
      expect(app.enables()).toBe(0);
      app.close();
    });
  });

  it("answers not started before any start, and creates no service when none runs", async () => {
    await withRegistry(async (registry) => {
      const result = await registry.invokeTool("native-network-logs", {
        udid: UDID,
        bundleId: BUNDLE,
      });

      expect(result).toEqual(NOT_STARTED);
      expect(registry.getSnapshot().services.has(nativeDevtoolsRef(device).urn)).toBe(false);
    });
  });

  it("refuses an Apple system app at once, also when no service runs", async () => {
    await withRegistry(async (registry) => {
      const err = await registry
        .invokeTool("native-network-logs", { udid: UDID, bundleId: "com.apple.Preferences" })
        .catch((e: unknown) => e);

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
      expect(registry.getSnapshot().services.has(nativeDevtoolsRef(device).urn)).toBe(false);
    });
  });

  it("lists what a stop kept with no precheck and no Network.enable, and without the missed-requests note", async () => {
    await withService(async (api) => {
      const app = await connectApp(api.socketPath, BUNDLE);
      // Started while the app runs, so a started read would say its launch was missed.
      await api.startNetworkCapture(BUNDLE, 8081);
      app.sendEvent("Network.requestWillBeSent", {
        requestId: "r1",
        request: { url: "https://example.com/kept", method: "GET", headers: {} },
      });
      await vi.waitFor(() => expect(api.networkRecords(BUNDLE)?.records(8081)).toHaveLength(1));
      await expect(api.stopNetworkCapture(BUNDLE)).resolves.toEqual({ confirmed: true });
      const precheckCalls = watchPrecheck(api);

      const stopped = await callTool(api);

      expect(stopped).toMatchObject({
        status: "ok",
        header: `ios-native: stopped, 1 request (${STOPPED_DETAIL})`,
        armed: false,
        stopped: true,
        requests: [expect.objectContaining({ url: "https://example.com/kept" })],
      });
      expect(precheckCalls()).toEqual([]);
      await settle();
      expect(app.enables()).toBe(1);

      // The next start of the running app missed what came before it, and its first read says so.
      await api.startNetworkCapture(BUNDLE, 8081);
      expect(headerOf(await callTool(api))).toMatch(/were not recorded/);
      app.close();
    });
  });

  it("lists 0 requests after a stop of an app that never connected, rather than failing as not connected", async () => {
    await withService(async (api) => {
      await api.startNetworkCapture(BUNDLE, 8081);
      await api.stopNetworkCapture(BUNDLE);

      expect(await callTool(api)).toEqual({
        status: "ok",
        header: `ios-native: stopped, 0 requests (${STOPPED_DETAIL})`,
        armed: false,
        stopped: true,
        count: 0,
        total: 0,
        requests: [],
      });
    });
  });

  it("sends no Network.enable from a read while started, also on a connection whose enable timed out, and names network-capture-start", async () => {
    await withService(async (api) => {
      const app = await connectApp(api.socketPath, BUNDLE, { answerEnable: false });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const arming = api.startNetworkCapture(BUNDLE, 8081);
        await vi.waitFor(() => expect(app.enables()).toBe(1));
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(arming).resolves.toBe(false);
      } finally {
        vi.useRealTimers();
      }
      const timedOut =
        "the agent did not acknowledge Network.enable within 5 s; network-capture-start asks again";

      // The first read also says the requests before the start were missed.
      expect(headerOf(await callTool(api))).toMatch(
        new RegExp(`^ios-native: not armed, 0 requests \\(${timedOut}; `)
      );
      expect(await callTool(api)).toMatchObject({
        status: "ok",
        armed: false,
        header: `ios-native: not armed, 0 requests (${timedOut})`,
      });
      await settle();
      expect(app.enables()).toBe(1);
      app.close();
    });
  });
});
