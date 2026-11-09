import { describe, it, expect, vi, afterEach } from "vitest";
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

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (_cmd: string, _args: readonly string[], opts: unknown, cb?: unknown) => {
      const callback = (typeof opts === "function" ? opts : cb) as (
        err: Error | null,
        out: { stdout: string; stderr: string }
      ) => void;
      callback(null, { stdout: "", stderr: "" });
    },
  };
});

import { nativeDevtoolsBlueprint, type NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import type { CdpNetworkConditions } from "../src/utils/network-conditions";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const UDID = processScopedUdid("-5555-6666-7777-888888888888");
const SOCKET = `/tmp/argent-nd-${UDID.slice(0, 8)}.sock`;
const BUNDLE = "com.example.app";
const device: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };

const SLOW: CdpNetworkConditions = {
  offline: false,
  latency: 400,
  downloadThroughput: 50_000,
  uploadThroughput: -1,
};

const ACTIVATE = { type: "Control", payload: { command: "activateNetworkInspection" } };
const EMULATE_SLOW = {
  type: "CDP",
  payload: { method: "Network.emulateNetworkConditions", params: SLOW },
};

interface FakeAgent {
  received: unknown[];
  isClosed(): boolean;
  close(): void;
}

function connectAgent(): Promise<FakeAgent> {
  return new Promise((resolve) => {
    const received: unknown[] = [];
    let buffer = "";
    let closed = false;
    const socket = net.createConnection(SOCKET, () => {
      socket.write(JSON.stringify({ type: "Control", payload: { bundleId: BUNDLE } }) + "\n");
      resolve({ received, isClosed: () => closed, close: () => socket.destroy() });
    });
    socket.on("close", () => {
      closed = true;
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) if (line) received.push(JSON.parse(line));
    });
  });
}

let disposeInstance: (() => Promise<void>) | null = null;
const agents: FakeAgent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.close();
  await disposeInstance?.();
  disposeInstance = null;
});

async function setup(): Promise<{ api: NativeDevtoolsApi; agent: FakeAgent }> {
  const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
  disposeInstance = instance.dispose;
  const api = instance.api as NativeDevtoolsApi;
  const agent = await connectAgent();
  agents.push(agent);
  await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));
  return { api, agent };
}

describe("native devtools network conditions", () => {
  it("sends the conditions to the app as a CDP message", async () => {
    const { api, agent } = await setup();

    api.setNetworkConditions(BUNDLE, SLOW);

    await vi.waitFor(() => expect(agent.received).toEqual([EMULATE_SLOW]));
  });

  it("re-sends the conditions after every network inspection activation", async () => {
    const { api, agent } = await setup();
    api.setNetworkConditions(BUNDLE, SLOW);

    api.activateNetworkInspection(BUNDLE);

    await vi.waitFor(() => expect(agent.received).toEqual([EMULATE_SLOW, ACTIVATE, EMULATE_SLOW]));
  });

  it("re-sends the conditions when the app reconnects after a relaunch", async () => {
    const { api } = await setup();
    api.activateNetworkInspection(BUNDLE);
    api.setNetworkConditions(BUNDLE, SLOW);

    const relaunched = await connectAgent();
    agents.push(relaunched);

    await vi.waitFor(() => expect(relaunched.received).toEqual([ACTIVATE, EMULATE_SLOW]));
  });

  it("clears back to plain monitoring when network inspection is active", async () => {
    const { api, agent } = await setup();
    api.activateNetworkInspection(BUNDLE);
    api.setNetworkConditions(BUNDLE, SLOW);

    api.setNetworkConditions(BUNDLE, null);

    await vi.waitFor(() => expect(agent.received).toEqual([ACTIVATE, EMULATE_SLOW, ACTIVATE]));
  });

  it("clears with Network.disable when network inspection was never activated", async () => {
    const { api, agent } = await setup();
    api.setNetworkConditions(BUNDLE, SLOW);

    api.setNetworkConditions(BUNDLE, null);

    await vi.waitFor(() =>
      expect(agent.received).toEqual([
        EMULATE_SLOW,
        { type: "CDP", payload: { method: "Network.disable" } },
      ])
    );
  });

  it("does not re-send cleared conditions on reconnect", async () => {
    const { api, agent } = await setup();
    api.setNetworkConditions(BUNDLE, SLOW);
    api.setNetworkConditions(BUNDLE, null);

    const relaunched = await connectAgent();
    agents.push(relaunched);
    await vi.waitFor(() => expect(agent.isClosed()).toBe(true));
    api.setNetworkConditions(BUNDLE, SLOW);

    await vi.waitFor(() => expect(relaunched.received).toEqual([EMULATE_SLOW]));
  });
});
