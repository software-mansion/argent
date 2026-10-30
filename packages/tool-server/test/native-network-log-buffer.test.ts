import { describe, it, expect, vi } from "vitest";
import * as net from "node:net";
import type { DeviceInfo } from "@argent/registry";

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

type ExecCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (_cmd: string, _args: readonly string[], opts: unknown, cb?: ExecCb) => {
      const callback = (typeof opts === "function" ? opts : cb!) as ExecCb;
      callback(null, { stdout: "", stderr: "" });
    },
  };
});

import { nativeDevtoolsBlueprint, type NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const UDID = processScopedUdid("-5555-6666-7777-888888888888");
const BUNDLE = "com.example.app";
const LOG_LIMIT = 1000;

const device: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };

function frame(type: string, payload: unknown): string {
  return JSON.stringify({ type, payload }) + "\n";
}

function cdpEvent(index: number): string {
  return frame("CDP", {
    method: "Network.dataReceived",
    params: { requestId: `r${index}`, dataLength: 1 },
  });
}

function sendEvents(sock: net.Socket, from: number, to: number) {
  const lines: string[] = [];
  for (let i = from; i < to; i++) lines.push(cdpEvent(i));
  sock.write(lines.join(""));
}

function requestIds(api: NativeDevtoolsApi): string[] {
  return api.getNetworkLog(BUNDLE).map((e) => (e.params as { requestId: string }).requestId);
}

async function waitForLastEvent(api: NativeDevtoolsApi, index: number) {
  await vi.waitFor(() => expect(requestIds(api).at(-1)).toBe(`r${index}`));
}

function connectAgent(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath, () => {
      sock.write(frame("Control", { bundleId: BUNDLE }));
      resolve(sock);
    });
  });
}

describe.skipIf(process.platform === "win32")("native-devtools network log ring buffer", () => {
  it("drops the oldest event past the limit, flags it, and resets on clear", async () => {
    const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
    const api = instance.api as NativeDevtoolsApi;
    const sock = await connectAgent(api.socketPath);
    try {
      await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));

      sendEvents(sock, 0, LOG_LIMIT);
      await waitForLastEvent(api, LOG_LIMIT - 1);
      expect(api.getNetworkLog(BUNDLE)).toHaveLength(LOG_LIMIT);
      expect(api.networkLogEvicted(BUNDLE)).toBe(false);

      sendEvents(sock, LOG_LIMIT, LOG_LIMIT + 1);
      await waitForLastEvent(api, LOG_LIMIT);
      const ids = requestIds(api);
      expect(ids).toHaveLength(LOG_LIMIT);
      expect(ids[0]).toBe("r1");
      expect(api.networkLogEvicted(BUNDLE)).toBe(true);

      const snapshot = api.getNetworkLog(BUNDLE);
      api.clearNetworkLog(BUNDLE);
      expect(snapshot).toHaveLength(LOG_LIMIT);
      expect(api.getNetworkLog(BUNDLE)).toEqual([]);
      expect(api.networkLogEvicted(BUNDLE)).toBe(false);
    } finally {
      sock.destroy();
      await instance.dispose();
    }
  });
});
