import { describe, it, expect, vi, beforeEach } from "vitest";
import * as net from "node:net";
import { FAILURE_CODES, getFailureSignal, Registry, type DeviceInfo } from "@argent/registry";

// Capture is armed by the tool but delivered by the blueprint: straight away to
// a connected app, or at the handshake of one that connects later (the relaunch
// `restart_required` asks for). These run the real blueprint against a fake app
// on its socket, so dropping either half brings the lost-launch bug back here.

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

import { nativeDevtoolsBlueprint, type NativeDevtoolsApi } from "../src/blueprints/native-devtools";
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

/**
 * Dial the service as the injected dylib does, recording every line it is sent
 * and acknowledging each CDP request.
 */
async function connectApp(socketPath: string, bundleId: string) {
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
      const { type, payload } = JSON.parse(line) as { type: string; payload: { id?: number } };
      if (type === "CDP" && payload.id !== undefined) {
        sock.write(JSON.stringify({ type, payload: { id: payload.id, result: {} } }) + "\n");
      }
    }
  });
  await settle();
  return { received, close: () => sock.destroy() };
}

async function withService(run: (api: NativeDevtoolsApi) => Promise<void>) {
  const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
  try {
    await run(instance.api as NativeDevtoolsApi);
  } finally {
    await instance.dispose();
  }
}

const callTool = (api: NativeDevtoolsApi, bundleId = BUNDLE) =>
  nativeNetworkLogsTool.execute(
    { nativeDevtools: api },
    { udid: UDID, bundleId, limit: 50, clear: false }
  );

describe("native-network-logs arms capture through the blueprint", () => {
  beforeEach(async () => {
    const { __resetDepCacheForTests, __primeDepCacheForTests } =
      await import("../src/utils/check-deps");
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun"]);
  });

  it("activates a connected app and says the first answer missed earlier requests", async () => {
    await withService(async (api) => {
      const app = await connectApp(api.socketPath, BUNDLE);

      const first = await callTool(api);

      await vi.waitFor(() => expect(app.received.some(isEnable)).toBe(true));
      expect(first).toMatchObject({ status: "ok", armed: true, count: 0 });
      expect((first as { header: string }).header).toMatch(/were not recorded.*restart-app/);

      // Capture was already on for the second call, so its count is the truth.
      const second = await callTool(api);
      expect(second).toMatchObject({ status: "ok" });
      expect((second as { header: string }).header).not.toMatch(/were not recorded/);
      app.close();
    });
  });

  it("activates an app at its handshake after answering restart_required", async () => {
    await withService(async (api) => {
      const result = await callTool(api);
      expect(result).toMatchObject({ status: "restart_required" });

      // The relaunch: capture must be on before the app sends its first request.
      const app = await connectApp(api.socketPath, BUNDLE);
      await vi.waitFor(() => expect(app.received.some(isEnable)).toBe(true));

      // That launch was captured, so the next answer carries no note.
      const next = await callTool(api);
      expect(next).toMatchObject({ status: "ok" });
      expect((next as { header: string }).header).not.toMatch(/were not recorded/);
      app.close();
    });
  });

  it("re-activates an already armed app when it reconnects after restart-app", async () => {
    await withService(async (api) => {
      const before = await connectApp(api.socketPath, BUNDLE);
      await callTool(api);
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
      vi.spyOn(api, "ensureEnvReady").mockRejectedValueOnce(new Error("simctl hiccup"));
      expect(await callTool(api)).toMatchObject({ status: "init_failed" });
      before.close();
      await settle();

      const after = await connectApp(api.socketPath, BUNDLE);
      await vi.waitFor(() => expect(after.received.some(isEnable)).toBe(true));

      const next = await callTool(api);
      expect(next).toMatchObject({ status: "ok" });
      expect((next as { header: string }).header).not.toMatch(/were not recorded/);
      after.close();
    });
  });

  it("never activates an Apple system app it refuses", async () => {
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
