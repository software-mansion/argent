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

import {
  nativeDevtoolsBlueprint,
  type NativeDevtoolsApi,
  type NetworkThrottle,
} from "../src/blueprints/native-devtools";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const UDID = processScopedUdid("-5555-6666-7777-888888888888");
const SOCKET = `/tmp/argent-nd-${UDID.slice(0, 8)}.sock`;
const BUNDLE = "com.example.app";
const device: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };

const SLOW_CONDITIONS = {
  offline: false,
  latency: 400,
  downloadThroughput: 50_000,
  uploadThroughput: -1,
};
const SLOW: NetworkThrottle = { conditions: SLOW_CONDITIONS, metroPort: 8081 };

// Turning network inspection on sends Network.enable, which resets the app's conditions.
const ACTIVATE = ["CDP", "Network.enable", {}];
const BYPASS_METRO = ["CDP", "NativeDevtoolsIos.configure", { bypassPorts: [8081] }];
const EMULATE_SLOW = ["CDP", "Network.emulateNetworkConditions", SLOW_CONDITIONS];

type Message = { type: string; payload: Record<string, any> };

interface FakeAgent {
  received: unknown[];
  isClosed(): boolean;
  close(): void;
}

/**
 * `reply` answers each CDP request that carries an id; `undefined` leaves it
 * unanswered, and a `delayMs` in the answer sends it that much later.
 */
function connectAgent(
  reply: (msg: Message) => Record<string, unknown> | undefined = () => ({ result: {} })
): Promise<FakeAgent> {
  return new Promise((resolve) => {
    const received: unknown[] = [];
    let buffer = "";
    let closed = false;
    const socket = net.createConnection(SOCKET, () => {
      socket.write(JSON.stringify({ type: "Control", payload: { bundleId: BUNDLE } }) + "\n");
      resolve({ received, isClosed: () => closed, close: () => socket.destroy() });
    });
    // A relaunch supersedes this connection, and the tool-server destroys it. A reply that it
    // did not read yet makes Linux reset the connection, so this side gets ECONNRESET.
    socket.on("error", () => {});
    socket.on("close", () => {
      closed = true;
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line) continue;
        const msg = JSON.parse(line) as Message;
        const { payload } = msg;
        received.push(
          [msg.type, payload.method ?? payload.command, payload.params].filter(
            (part) => part !== undefined
          )
        );
        const answer = msg.type === "CDP" && payload.id !== undefined ? reply(msg) : undefined;
        if (answer) {
          const { delayMs, ...rest } = answer as { delayMs?: number };
          const send = () =>
            socket.write(
              JSON.stringify({ type: "CDP", payload: { id: payload.id, ...rest } }) + "\n"
            );
          if (delayMs) setTimeout(send, delayMs);
          else send();
        }
      }
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

async function startService(): Promise<NativeDevtoolsApi> {
  const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
  disposeInstance = instance.dispose;
  return instance.api as NativeDevtoolsApi;
}

async function connect(api: NativeDevtoolsApi, reply?: Parameters<typeof connectAgent>[0]) {
  const agent = await connectAgent(reply);
  agents.push(agent);
  await vi.waitFor(() => expect(api.isConnected(BUNDLE)).toBe(true));
  return agent;
}

async function setup(reply?: Parameters<typeof connectAgent>[0]) {
  const api = await startService();
  const agent = await connect(api, reply);
  return { api, agent };
}

describe("native devtools network conditions", () => {
  it("sends the Metro bypass and the conditions, and resolves once the app confirms them", async () => {
    const { api, agent } = await setup();

    await api.setNetworkConditions(BUNDLE, SLOW);

    expect(agent.received).toEqual([BYPASS_METRO, EMULATE_SLOW]);
  });

  it("rejects with the app's error when the app refuses the conditions", async () => {
    const { api } = await setup((msg) =>
      msg.payload.method === "Network.emulateNetworkConditions"
        ? { error: { message: "latency must be >= 0" } }
        : { result: {} }
    );

    await expect(api.setNetworkConditions(BUNDLE, SLOW)).rejects.toThrow("latency must be >= 0");
  });

  it("rejects when the app never answers", async () => {
    const { api } = await setup(() => undefined);

    await expect(api.setNetworkConditions(BUNDLE, SLOW)).rejects.toThrow(
      /got no reply within 5000 ms/
    );
  }, 10_000);

  it("keeps the previous conditions for the next launch when the app refuses new ones", async () => {
    const { api } = await setup((msg) =>
      msg.payload.params?.latency === 900 ? { error: { message: "rejected" } } : { result: {} }
    );
    await api.setNetworkConditions(BUNDLE, SLOW);
    const refused = { ...SLOW, conditions: { ...SLOW_CONDITIONS, latency: 900 } };

    await expect(api.setNetworkConditions(BUNDLE, refused)).rejects.toThrow("rejected");
    const relaunched = await connectAgent();
    agents.push(relaunched);

    await vi.waitFor(() => expect(relaunched.received).toEqual([BYPASS_METRO, EMULATE_SLOW]));
  });

  it("does not apply a first throttle the app refused on the next launch", async () => {
    const { api } = await setup((msg) =>
      msg.payload.method === "Network.emulateNetworkConditions"
        ? { error: { message: "rejected" } }
        : { result: {} }
    );

    await expect(api.setNetworkConditions(BUNDLE, SLOW)).rejects.toThrow("rejected");
    const relaunched = await connectAgent();
    agents.push(relaunched);
    void api.activateNetworkInspection(BUNDLE);

    await vi.waitFor(() => expect(relaunched.received).toEqual([ACTIVATE]));
  });

  it("still clears at a reset after a throttle the app refused", async () => {
    const { api, agent } = await setup((msg) =>
      msg.payload.method === "Network.emulateNetworkConditions"
        ? { error: { message: "rejected" } }
        : { result: {} }
    );
    await expect(api.setNetworkConditions(BUNDLE, SLOW)).rejects.toThrow("rejected");
    agent.received.length = 0;

    await api.setNetworkConditions(BUNDLE, null);

    expect(agent.received).toEqual([
      ["CDP", "NativeDevtoolsIos.configure", { bypassPorts: [] }],
      ["CDP", "Network.disable", {}],
    ]);
  });

  it("keeps conditions a later call set while an earlier call was failing", async () => {
    const { api } = await setup((msg) =>
      msg.payload.params?.latency === 900 ? undefined : { result: {} }
    );
    const unanswered = { ...SLOW, conditions: { ...SLOW_CONDITIONS, latency: 900 } };

    const first = api.setNetworkConditions(BUNDLE, unanswered);
    await api.setNetworkConditions(BUNDLE, SLOW);
    await expect(first).rejects.toThrow(/got no reply within 5000 ms/);
    const relaunched = await connectAgent();
    agents.push(relaunched);

    await vi.waitFor(() => expect(relaunched.received).toEqual([BYPASS_METRO, EMULATE_SLOW]));
  }, 10_000);

  it("logs when the app refuses the conditions re-sent on reconnect", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { api } = await setup();
      await api.setNetworkConditions(BUNDLE, SLOW);

      const relaunched = await connectAgent((msg) =>
        msg.payload.method === "Network.emulateNetworkConditions"
          ? { error: { message: "latency must be >= 0" } }
          : { result: {} }
      );
      agents.push(relaunched);

      await vi.waitFor(() =>
        expect(stderr).toHaveBeenCalledWith(
          expect.stringMatching(
            /could not re-apply network conditions to com\.example\.app: .*latency must be >= 0/
          )
        )
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("re-sends the conditions after the first network inspection activation only", async () => {
    const { api, agent } = await setup();
    await api.setNetworkConditions(BUNDLE, SLOW);

    void api.activateNetworkInspection(BUNDLE);

    const afterFirstActivation = [BYPASS_METRO, EMULATE_SLOW, ACTIVATE, BYPASS_METRO, EMULATE_SLOW];
    await vi.waitFor(() => expect(agent.received).toEqual(afterFirstActivation));

    void api.activateNetworkInspection(BUNDLE);
    await api.setNetworkConditions(BUNDLE, SLOW);

    expect(agent.received).toEqual([...afterFirstActivation, BYPASS_METRO, EMULATE_SLOW]);
  });

  it("keeps the given Metro port out of the throttle across a relaunch", async () => {
    const { api, agent } = await setup();
    const bypass8095 = ["CDP", "NativeDevtoolsIos.configure", { bypassPorts: [8095] }];

    await api.setNetworkConditions(BUNDLE, { ...SLOW, metroPort: 8095 });
    const relaunched = await connectAgent();
    agents.push(relaunched);

    expect(agent.received).toEqual([bypass8095, EMULATE_SLOW]);
    await vi.waitFor(() => expect(relaunched.received).toEqual([bypass8095, EMULATE_SLOW]));
  });

  it("re-sends the conditions when the app reconnects after a relaunch", async () => {
    const { api } = await setup();
    void api.activateNetworkInspection(BUNDLE);
    await api.setNetworkConditions(BUNDLE, SLOW);

    const relaunched = await connectAgent();
    agents.push(relaunched);

    await vi.waitFor(() =>
      expect(relaunched.received).toEqual([ACTIVATE, BYPASS_METRO, EMULATE_SLOW])
    );
  });

  it("clears back to plain monitoring when network inspection is active", async () => {
    const { api, agent } = await setup();
    void api.activateNetworkInspection(BUNDLE);
    await api.setNetworkConditions(BUNDLE, SLOW);
    agent.received.length = 0;

    await api.setNetworkConditions(BUNDLE, null);

    expect(agent.received).toEqual([
      ["CDP", "NativeDevtoolsIos.configure", { bypassPorts: [] }],
      ["CDP", "Network.enable", {}],
    ]);
  });

  it("sends the conditions again after Network.enable without waiting for the bypass reply", async () => {
    let slowBypass = false;
    const { api, agent } = await setup((msg) =>
      slowBypass && msg.payload.method === "NativeDevtoolsIos.configure"
        ? { result: {}, delayMs: 1_000 }
        : { result: {} }
    );
    await api.setNetworkConditions(BUNDLE, SLOW);
    agent.received.length = 0;
    slowBypass = true;

    void api.activateNetworkInspection(BUNDLE);

    // A wait for the bypass reply would leave the app unthrottled for that round trip.
    await vi.waitFor(() => expect(agent.received).toEqual([ACTIVATE, BYPASS_METRO, EMULATE_SLOW]), {
      timeout: 500,
    });
  });

  it("clears with Network.disable when network inspection was never activated", async () => {
    const { api, agent } = await setup();
    await api.setNetworkConditions(BUNDLE, SLOW);
    agent.received.length = 0;

    await api.setNetworkConditions(BUNDLE, null);

    expect(agent.received).toEqual([
      ["CDP", "NativeDevtoolsIos.configure", { bypassPorts: [] }],
      ["CDP", "Network.disable", {}],
    ]);
  });

  it("sends the clear again when a retried reset follows a failed one", async () => {
    let refuseClear = true;
    const { api, agent } = await setup((msg) => {
      const clearsBypass = msg.payload.params?.bypassPorts?.length === 0;
      if (clearsBypass && refuseClear) {
        refuseClear = false;
        return { error: { message: "configure failed" } };
      }
      return { result: {} };
    });
    await api.setNetworkConditions(BUNDLE, SLOW);

    await expect(api.setNetworkConditions(BUNDLE, null)).rejects.toThrow("configure failed");
    agent.received.length = 0;
    await api.setNetworkConditions(BUNDLE, null);

    expect(agent.received).toEqual([
      ["CDP", "NativeDevtoolsIos.configure", { bypassPorts: [] }],
      ["CDP", "Network.disable", {}],
    ]);
  });

  it("does not re-send cleared conditions on reconnect", async () => {
    const { api, agent } = await setup();
    await api.setNetworkConditions(BUNDLE, SLOW);
    await api.setNetworkConditions(BUNDLE, null);

    const relaunched = await connectAgent();
    agents.push(relaunched);
    await vi.waitFor(() => expect(agent.isClosed()).toBe(true));
    void api.activateNetworkInspection(BUNDLE);

    await vi.waitFor(() => expect(relaunched.received).toEqual([ACTIVATE]));
  });

  it("forgets conditions cleared while the app was not connected", async () => {
    const api = await startService();
    await api.setNetworkConditions(BUNDLE, SLOW);
    await api.setNetworkConditions(BUNDLE, null);

    const agent = await connect(api);
    void api.activateNetworkInspection(BUNDLE);

    await vi.waitFor(() => expect(agent.received).toEqual([ACTIVATE]));
  });
});
