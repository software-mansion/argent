import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While a test sets `runningApp`, the host's `launchctl list` and `ps` report
 * that app running and every such probe is recorded. Unset, every command runs
 * for real.
 */
const hostProbe = vi.hoisted(() => ({
  probes: [] as string[],
  runningApp: undefined as { bundleId: string; pid: number } | undefined,
}));

vi.mock("node:child_process", async () => {
  const { promisify } = await vi.importActual<typeof import("node:util")>("node:util");
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const execFileForReal = promisify(actual.execFile);

  /** What `promisify(execFile)` returns, which is how ios-host runs its probes. */
  const execFileAsync = (file: string, args: readonly string[] = [], options = {}) => {
    const app = hostProbe.runningApp;
    const argv = args.join(" ");
    const listsJobs = argv.includes("launchctl list");
    if (!app || !(listsJobs || /\bps$/.test(file))) return execFileForReal(file, args, options);

    hostProbe.probes.push(`${file} ${argv}`);
    const stdout = listsJobs
      ? `${app.pid}\t0\tUIKitApplication:${app.bundleId}[dffa][rb-legacy]\n`
      : "00:05 /Example.app/Example\n";
    return Promise.resolve({ stdout, stderr: "" });
  };

  const execFile = (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args);
  return { ...actual, execFile: Object.assign(execFile, { [promisify.custom]: execFileAsync }) };
});

import { FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";
import {
  NATIVE_DEVTOOLS_ATTACH_HANDSHAKE_TIMEOUT_MS,
  nativeDevtoolsBlueprint,
  nativeDevtoolsRef,
} from "../src/blueprints/native-devtools";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { resolveDevice } from "../src/utils/device-info";
import {
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  makeExternalId,
} from "../src/utils/external-devices";

/**
 * `DYLD_INSERT_LIBRARIES` and the agent's endpoint are simulator-wide launchd
 * values, so two products arming their own injection overwrite each other, and
 * two builds of the same agent in one process would duplicate its classes and
 * swizzles.
 *
 * A provider that already injects lends us its agent connection instead. These
 * assert that we attach to what it published, drive the app through it and
 * arm nothing of our own.
 */

const BUNDLE_ID = "com.example.app";
const IOS_UDID = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809";
const PROVIDER_ID = "acme-3f2a9c";
const DEVICE_ID = makeExternalId(PROVIDER_ID, IOS_UDID);
const METRO_PORT = 8081;

let temporaryDirectory: string;

/**
 * Stands in for the provider: serves the agent's side of the wire, opening
 * with the `Control` frame that names the app it is lending.
 */
type LentAgent = {
  close: () => Promise<void>;
  /** How many connections argent opened to the agent so far. */
  connections: () => number;
  hangUp: () => void;
  /** Sends the deferred `Control` frame of a `deferHandshake` agent. */
  handshake: () => void;
  /** Calls back when the next socket closes, i.e. when we hang up. */
  onPeerClosed: (callback: () => void) => void;
  /** Sends a CDP event, as the provider does with the app's network events. */
  sendEvent: (method: string, params: Record<string, unknown>) => void;
  /** Turns capture on or off, as the user can in the provider at any time. */
  setCaptureOn: (on: boolean) => void;
  received: Array<{ type: string; payload: Record<string, unknown> }>;
  /** What the provider does when it turns its own network capture on or off. */
  setCapture: (on: boolean) => void;
  socketPath: string;
};

type LentAgentOptions = {
  /** Holds the `Control` handshake until `handshake()`. */
  deferHandshake?: boolean;
  /** Sends the `Control` handshake this long after accept rather than straight away. */
  handshakeDelayMs?: number;
  /** The agent's network capture when Argent attaches. */
  captureOn?: boolean;
  /** The error that the agent answers a read of its capture with. */
  conditionsError?: string;
  /** An older agent that has no `NativeDevtoolsIos.getConditions`. */
  failsGetConditions?: boolean;
  refusesConditions?: boolean;
};

/** Follows the capture state of the agent in the app: throttling turns capture on. */
function captureAfter(method: unknown, captureOn: boolean): boolean {
  if (method === "Network.enable" || method === "Network.emulateNetworkConditions") return true;
  if (method === "Network.disable") return false;
  return captureOn;
}

function cdpReply(
  id: unknown,
  method: unknown,
  state: { captureOn: boolean } & Omit<LentAgentOptions, "captureOn">
) {
  if (method === "Network.emulateNetworkConditions" && state.refusesConditions) {
    return { id, error: { message: "rejected" } };
  }
  if (method !== "NativeDevtoolsIos.getConditions") return { id, result: {} };
  if (state.failsGetConditions) return { id, error: { message: "Unknown method" } };
  if (state.conditionsError !== undefined) return { id, error: { message: state.conditionsError } };
  return { id, result: { enabled: state.captureOn, offline: false, latency: 2000 } };
}

async function startLentAgent({
  deferHandshake = false,
  handshakeDelayMs,
  captureOn = true,
  conditionsError,
  failsGetConditions = false,
  refusesConditions = false,
}: LentAgentOptions = {}): Promise<LentAgent> {
  const socketPath = path.join(temporaryDirectory, "agent.sock");
  const received: LentAgent["received"] = [];
  const sockets: net.Socket[] = [];
  const closeWaiters: Array<() => void> = [];
  let connections = 0;
  const state = { captureOn, conditionsError, failsGetConditions, refusesConditions };

  const sendHandshake = (socket: net.Socket) =>
    socket.write(JSON.stringify({ payload: { bundleId: BUNDLE_ID }, type: "Control" }) + "\n");

  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("close", () => closeWaiters.splice(0).forEach((callback) => callback()));
    connections++;
    if (handshakeDelayMs !== undefined) setTimeout(() => sendHandshake(socket), handshakeDelayMs);
    else if (!deferHandshake) sendHandshake(socket);

    readline.createInterface({ input: socket }).on("line", (raw) => {
      const message = JSON.parse(raw);
      received.push(message);

      /** Answer CDP requests and `ViewInspector` RPCs the way the agent in the app would. */
      if (message.type === "ViewInspector") {
        socket.write(
          JSON.stringify({
            payload: { id: message.payload.id, result: { role: "AXWindow" } },
            type: "ViewInspector",
          }) + "\n"
        );
      }

      if (message.type === "CDP") {
        const { id, method } = message.payload;
        if (id !== undefined) {
          const payload = cdpReply(id, method, state);
          socket.write(JSON.stringify({ payload, type: "CDP" }) + "\n");
        }
        state.captureOn = captureAfter(method, state.captureOn);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    connections: () => connections,
    /** What a provider does when the app it was lending goes away. */
    hangUp: () => {
      for (const socket of sockets.splice(0)) socket.destroy();
    },
    handshake: () => {
      for (const socket of sockets) sendHandshake(socket);
    },
    onPeerClosed: (callback) => closeWaiters.push(callback),
    sendEvent: (method, params) => {
      for (const socket of sockets) {
        socket.write(JSON.stringify({ payload: { method, params }, type: "CDP" }) + "\n");
      }
    },
    setCaptureOn: (on) => {
      state.captureOn = on;
    },
    received,
    setCapture: (on) => {
      state.captureOn = on;
    },
    socketPath,
  };
}

function publishDescriptor(options: { socketPath?: string } = {}): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");

  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: [
        {
          capabilities: ["native-devtools", "simctl"],
          kind: "simulator",
          name: "iPhone 16 Pro",
          ...(options.socketPath ? { nativeDevtools: { socketPath: options.socketPath } } : {}),
          nativeId: IOS_UDID,
          platform: "ios",
          state: "Booted",
        },
      ],
      id: PROVIDER_ID,
      name: "Acme IDE",
      schemaVersion: 1,
    })
  );

  process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
}

function instantiate(deviceId = DEVICE_ID, signal?: AbortSignal) {
  const device = resolveDevice(deviceId);
  return nativeDevtoolsBlueprint.factory({}, device, { device }, signal);
}

/**
 * Wait for a handshake that lands after `instantiate()` resolved. One that
 * comes in time is already in `connections` when it resolves.
 */
async function waitForConnectedBundle(api: {
  listConnectedBundleIds: () => string[];
}): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (api.listConnectedBundleIds().length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Fail here rather than on the next RPC, which would only say "not
   * connected".
   */
  throw new Error("the lent agent never reported a connected bundle");
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-native-devtools-"));
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  __resetExternalDeviceCacheForTesting();
  __resetProviderWarningsForTesting();
  /**
   * The tools check for `xcrun` first and Linux CI has none. Nothing runs it.
   */
  __primeDepCacheForTests(["xcrun"]);
});

afterEach(() => {
  hostProbe.probes = [];
  hostProbe.runningApp = undefined;
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  __resetDepCacheForTests();
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
});

describe("a provider that lends its native-devtools agent", () => {
  it("attaches to the published socket and adopts the app it is serving", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();

    expect(instance.api.listConnectedBundleIds()).toEqual([BUNDLE_ID]);
    expect(instance.api.isConnected(BUNDLE_ID)).toBe(true);
    expect(instance.api.socketPath).toBe(agent.socketPath);

    await instance.dispose();
    await agent.close();
  });

  it("queries the view hierarchy over the lent connection", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    expect(instance.api.listConnectedBundleIds()).toEqual([BUNDLE_ID]);

    await expect(
      instance.api.queryViewHierarchy(BUNDLE_ID, "ViewHierarchy.describeScreen")
    ).resolves.toEqual({ role: "AXWindow" });

    expect(agent.received).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ method: "ViewHierarchy.describeScreen" }),
        type: "ViewInspector",
      })
    );

    await instance.dispose();
    await agent.close();
  });

  /**
   * The provider armed the injection, so there is nothing of ours to set up
   * and no reason to make the agent restart somebody else's app.
   */
  it("arms no injection of its own and never asks for a restart", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    expect(instance.api.listConnectedBundleIds()).toEqual([BUNDLE_ID]);

    expect(instance.api.isEnvSetup()).toBe(true);
    expect(instance.api.getInitFailure()).toBeNull();
    await expect(instance.api.appConnectionState("com.example.other")).resolves.toBe(
      "provider_attached"
    );

    await instance.dispose();
    await agent.close();
  });

  /**
   * The process behind a lent agent is the provider's. Probing its simulator
   * for a pid would put one argent never launched in the network-logs header.
   */
  it("never probes the host for the pid of the app it attached to", async () => {
    hostProbe.runningApp = { bundleId: BUNDLE_ID, pid: 4242 };
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    await waitForConnectedBundle(instance.api);
    /** The probe would start at the handshake and land a few ticks later. */
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(hostProbe.probes).toEqual([]);
    const records = instance.api.networkRecords(BUNDLE_ID);
    expect(records).toBeDefined();
    expect(records!.state().pid).toBeUndefined();

    await instance.dispose();
    await agent.close();
  });

  /** Hanging up must not disturb what the provider is running. */
  it("leaves the provider's socket in place when disposed", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    expect(instance.api.listConnectedBundleIds()).toEqual([BUNDLE_ID]);
    await instance.dispose();

    expect(fs.existsSync(agent.socketPath)).toBe(true);

    await agent.close();
  });

  /**
   * `{count: 0}` reads as "the screen made no requests", which is a different
   * thing from "nothing is capturing them".
   */
  it("says the app is not connected rather than reporting an empty network log", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    await waitForConnectedBundle(instance.api);
    // Before a start the read answers not started, whatever is connected.
    await instance.api.startNetworkCapture("com.example.gone", METRO_PORT);

    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");

    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

    const err = await nativeNetworkLogsTool
      .execute(
        { nativeDevtools: instance.api },
        { bundleId: "com.example.gone", clear: false, limit: 50, udid: DEVICE_ID }
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not connected/);
    expect((err as Error).message).toMatch(/no native network log is being captured for it/);
    expect((err as Error).message).toMatch(/view-network-logs/);
    expect((err as Error).message).not.toMatch(/describe or screenshot/);
    expect((err as Error).message).not.toMatch(/call again in a few seconds/);

    await instance.dispose();
    await agent.close();
  });

  /**
   * The lent app was running before we attached, so its launch is missed. The
   * note must say so on the first ok answer, even when an earlier call failed
   * because the handshake had not landed, and must not send the agent to
   * restart an app whose relaunch ends capture here.
   *
   * The attach sits out its handshake wait before that earlier call can run.
   * The clock that dates the handshake stands still, so the handshake still
   * counts as prompt.
   */
  it(
    "notes the missed launch on the first ok answer without advising a restart",
    async () => {
      vi.useFakeTimers({ toFake: ["performance"] });
      try {
        const agent = await startLentAgent({ deferHandshake: true });
        publishDescriptor({ socketPath: agent.socketPath });

        const instance = await instantiate();
        await instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT);
        const { createNativeNetworkLogsTool } =
          await import("../src/tools/native-devtools/native-network-logs");
        const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());
        const call = () =>
          nativeNetworkLogsTool.execute(
            { nativeDevtools: instance.api },
            { bundleId: BUNDLE_ID, clear: false, limit: 50, udid: DEVICE_ID }
          );

        await expect(call()).rejects.toThrow(/not connected/);

        agent.handshake();
        await waitForConnectedBundle(instance.api);

        const first = (await call()) as { status: string; header: string };
        expect(first.status).toBe("ok");
        expect(first.header).toMatch(/were not recorded/);
        expect(first.header).not.toMatch(/restart-app/);

        const second = (await call()) as { header: string };
        expect(second.header).not.toMatch(/were not recorded/);

        await instance.dispose();
        await agent.close();
      } finally {
        vi.useRealTimers();
      }
    },
    NATIVE_DEVTOOLS_ATTACH_HANDSHAKE_TIMEOUT_MS + 3_000
  );

  /**
   * A provider that has no app yet accepts us and hands the app over when its
   * agent arrives with the app's launch. We hear that app from its launch on,
   * so nothing was missed and the note must not say the launch was.
   */
  it(
    "does not note a missed launch when the app's agent arrived after argent connected",
    async () => {
      vi.useFakeTimers({ toFake: ["performance"] });
      try {
        const agent = await startLentAgent({ deferHandshake: true });
        publishDescriptor({ socketPath: agent.socketPath });

        const instance = await instantiate();
        const { createNativeNetworkLogsTool } =
          await import("../src/tools/native-devtools/native-network-logs");
        const { Registry } = await import("@argent/registry");
        const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

        // The app launches a while after argent connected.
        vi.advanceTimersByTime(5_000);
        agent.handshake();
        await waitForConnectedBundle(instance.api);
        agent.sendEvent("Network.requestWillBeSent", {
          requestId: "r1",
          request: { url: "https://example.com/at-launch", method: "GET", headers: {} },
        });
        agent.sendEvent("Network.loadingFinished", { requestId: "r1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT);

        const listing = (await nativeNetworkLogsTool.execute(
          { nativeDevtools: instance.api },
          { bundleId: BUNDLE_ID, clear: false, limit: 50, udid: DEVICE_ID }
        )) as { header: string; requests: Array<{ url: string }> };

        expect(listing.requests.map((request) => request.url)).toEqual([
          "https://example.com/at-launch",
        ]);
        expect(listing.header).not.toMatch(/were not recorded/);

        await instance.dispose();
        await agent.close();
      } finally {
        vi.useRealTimers();
      }
    },
    NATIVE_DEVTOOLS_ATTACH_HANDSHAKE_TIMEOUT_MS + 3_000
  );

  /**
   * A lent agent's events reach argent from the handshake on, before
   * network-capture-start. The note must not say a request it lists was missed.
   */
  it("says the requests before argent connected were missed, and lists the ones after", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      // The tool-server has run for a while, so the window must count from argent's connect.
      vi.advanceTimersByTime(60_000);
      const agent = await startLentAgent();
      publishDescriptor({ socketPath: agent.socketPath });

      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);
      agent.sendEvent("Network.requestWillBeSent", {
        requestId: "r1",
        request: { url: "https://example.com/before-the-first-call", method: "GET", headers: {} },
      });
      agent.sendEvent("Network.loadingFinished", { requestId: "r1" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT);

      const { createNativeNetworkLogsTool } =
        await import("../src/tools/native-devtools/native-network-logs");
      const { Registry } = await import("@argent/registry");
      const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());
      const listing = (await nativeNetworkLogsTool.execute(
        { nativeDevtools: instance.api },
        { bundleId: BUNDLE_ID, clear: false, limit: 50, udid: DEVICE_ID }
      )) as { header: string; requests: Array<{ url: string }> };

      expect(listing.requests.map((request) => request.url)).toEqual([
        "https://example.com/before-the-first-call",
      ]);
      expect(listing.header).toMatch(
        /argent connected to the app's agent while the app was running, so the requests before that, its launch among them, were not recorded/
      );
      expect(listing.header).not.toMatch(/capture started/);

      await instance.dispose();
      await agent.close();
    } finally {
      vi.useRealTimers();
    }
  });

  /** A read never starts capture, so before a start it has nothing to ask the provider. */
  it("answers not started before network-capture-start and asks the lent agent nothing", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    await waitForConnectedBundle(instance.api);

    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { Registry } = await import("@argent/registry");
    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

    const listing = (await nativeNetworkLogsTool.execute(
      { nativeDevtools: instance.api },
      { bundleId: BUNDLE_ID, clear: false, limit: 50, udid: DEVICE_ID }
    )) as { started?: boolean; header: string };

    expect(listing.started).toBe(false);
    expect(listing.header).toMatch(/^ios-native: not started, 0 requests/);
    expect(agent.received.filter((message) => message.type === "CDP")).toEqual([]);

    await instance.dispose();
    await agent.close();
  });

  /**
   * The provider owns the agent's network config, and Network.enable replaces
   * all of it, the provider's throttling with it. So argent only reads whether
   * capture is on, and the methods the agent received show that it did.
   */
  it("reads whether capture is on over the lent connection and never sends Network.enable", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    await waitForConnectedBundle(instance.api);

    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { Registry } = await import("@argent/registry");
    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());
    const cdpMethods = () =>
      agent.received
        .filter((message) => message.type === "CDP")
        .map((message) => message.payload.method);
    const call = () =>
      nativeNetworkLogsTool.execute(
        { nativeDevtools: instance.api },
        { bundleId: BUNDLE_ID, clear: false, limit: 50, udid: DEVICE_ID }
      ) as Promise<{ armed: boolean; header: string; status: string }>;

    await expect(instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT)).resolves.toBe(true);
    const listing = await call();
    await call();

    expect(listing.status).toBe("ok");
    expect(listing.armed).toBe(true);
    expect(listing.header).toMatch(/^ios-native: armed, 0 requests/);
    // The start reads it, then every read again: the provider can turn capture off at any time.
    expect(cdpMethods()).toEqual([
      "NativeDevtoolsIos.getConditions",
      "NativeDevtoolsIos.getConditions",
      "NativeDevtoolsIos.getConditions",
    ]);

    await instance.dispose();
    await agent.close();
  });

  it("says the provider has capture off rather than turning it on", async () => {
    const agent = await startLentAgent({ captureOn: false });
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    await waitForConnectedBundle(instance.api);

    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { Registry } = await import("@argent/registry");
    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

    await expect(instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT)).resolves.toBe(false);
    const listing = (await nativeNetworkLogsTool.execute(
      { nativeDevtools: instance.api },
      { bundleId: BUNDLE_ID, clear: false, limit: 50, udid: DEVICE_ID }
    )) as { armed: boolean; header: string };

    expect(listing.armed).toBe(false);
    expect(listing.header).toMatch(
      /^ios-native: not armed, 0 requests \(the device provider has capture off for the app; argent does not turn it on/
    );
    expect(agent.received.map((message) => message.payload.method)).not.toContain("Network.enable");

    await instance.dispose();
    await agent.close();
  });

  /**
   * Network.disable would change the provider's setting as Network.enable does,
   * so a stop only ends argent's own recording of the app.
   */
  it("stops without sending Network.disable and records none of the provider's later requests", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    await waitForConnectedBundle(instance.api);
    await instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT);

    await expect(instance.api.stopNetworkCapture(BUNDLE_ID)).resolves.toEqual({
      confirmed: true,
      reason:
        "the device provider keeps its own capture setting for the app; argent records none of its new requests",
    });
    agent.sendEvent("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/after-the-stop", method: "GET", headers: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { Registry } = await import("@argent/registry");
    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());
    const listing = (await nativeNetworkLogsTool.execute(
      { nativeDevtools: instance.api },
      { bundleId: BUNDLE_ID, clear: false, limit: 50, udid: DEVICE_ID }
    )) as { stopped?: boolean; header: string; total: number };

    expect(listing.stopped).toBe(true);
    expect(listing.header).toMatch(/^ios-native: stopped, 0 requests/);
    expect(listing.total).toBe(0);
    const cdpMethods = () =>
      agent.received
        .filter((message) => message.type === "CDP")
        .map((message) => message.payload.method);
    expect(cdpMethods()).toEqual(["NativeDevtoolsIos.getConditions"]);

    // Hanging up on a stopped app sends it nothing either.
    await instance.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cdpMethods()).toEqual(["NativeDevtoolsIos.getConditions"]);
    await agent.close();
  });

  /**
   * The capture here is the provider's: argent did not turn it on, and the
   * profiler's remedy (network-capture-stop, then restart the app) neither
   * ends it nor suits a device where a relaunch ends capture.
   */
  it("does not warn a profiler start about the provider's capture after a start", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    await waitForConnectedBundle(instance.api);
    await instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT);

    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { nativeNetworkCaptureWarning } =
      await import("../src/utils/profiler-shared/network-capture-warning");
    const { liveIosNetworkCaptureDevices } = await import("../src/blueprints/ios-network-records");
    const { Registry } = await import("@argent/registry");
    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

    const listing = (await nativeNetworkLogsTool.execute(
      { nativeDevtools: instance.api },
      { bundleId: BUNDLE_ID, clear: false, limit: 50, udid: DEVICE_ID }
    )) as { armed: boolean };

    expect(listing.armed).toBe(true);
    expect(nativeNetworkCaptureWarning(DEVICE_ID)).toBeUndefined();
    expect(nativeNetworkCaptureWarning(IOS_UDID)).toBeUndefined();
    expect(liveIosNetworkCaptureDevices(BUNDLE_ID)).toEqual([]);

    await instance.dispose();
    await agent.close();
  });

  /**
   * The provider can turn capture off between two calls. The second call must
   * say so, not repeat what the first one read.
   */
  it("says capture is off when the provider turned it off after an earlier call", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    await waitForConnectedBundle(instance.api);
    await instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT);

    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { Registry } = await import("@argent/registry");
    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());
    const call = () =>
      nativeNetworkLogsTool.execute(
        { nativeDevtools: instance.api },
        { bundleId: BUNDLE_ID, clear: false, limit: 50, udid: DEVICE_ID }
      ) as Promise<{ armed: boolean; header: string }>;

    const first = await call();
    agent.setCaptureOn(false);
    const second = await call();

    expect(first.armed).toBe(true);
    expect(first.header).toMatch(/^ios-native: armed, 0 requests/);
    expect(second.armed).toBe(false);
    expect(second.header).toMatch(
      /^ios-native: not armed, 0 requests \(the device provider has capture off for the app;/
    );

    await instance.dispose();
    await agent.close();
  });

  /**
   * A provider that cannot pass the read on answers it with an error. The note
   * must say what argent asked, and not name Network.enable, which argent never
   * sends here.
   */
  it("says the agent did not say whether capture is on when the provider answers the read with an error", async () => {
    const agent = await startLentAgent({
      conditionsError: "native devtools connection is not available",
    });
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    await waitForConnectedBundle(instance.api);
    await instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT);

    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { Registry } = await import("@argent/registry");
    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

    const listing = (await nativeNetworkLogsTool.execute(
      { nativeDevtools: instance.api },
      { bundleId: BUNDLE_ID, clear: false, limit: 50, udid: DEVICE_ID }
    )) as { armed: boolean; header: string };

    expect(listing.armed).toBe(false);
    expect(listing.header).toMatch(
      /^ios-native: not armed, 0 requests \(the agent did not say whether capture is on \([^)]*native devtools connection is not available\); the next call asks again/
    );
    expect(listing.header).not.toMatch(/Network\.enable/);

    await instance.dispose();
    await agent.close();
  });

  /**
   * We are the client on this path, so nothing re-dials on its own. Without a
   * terminated signal the registry would keep serving this instance and its
   * dead socket for the rest of the session, and an app relaunch would never
   * come back.
   */
  it("terminates when the provider hangs up, so the next call re-attaches", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    expect(instance.api.listConnectedBundleIds()).toEqual([BUNDLE_ID]);

    const terminated = new Promise<void>((resolve) =>
      instance.events.on("terminated", () => resolve())
    );

    agent.hangUp();
    await terminated;

    /** A fresh resolve attaches again and re-adopts the app on offer. */
    const reattached = await instantiate();
    expect(reattached.api.listConnectedBundleIds()).toEqual([BUNDLE_ID]);

    await reattached.dispose();
    await instance.dispose();
    await agent.close();
  });

  /** Our own hang-up is not the provider dropping us. */
  it("does not terminate when we are the one disposing", async () => {
    const agent = await startLentAgent();
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    expect(instance.api.listConnectedBundleIds()).toEqual([BUNDLE_ID]);

    let terminated = false;
    instance.events.on("terminated", () => {
      terminated = true;
    });

    await instance.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(terminated).toBe(false);

    await agent.close();
  });

  /**
   * Accept proves only that the provider is listening; the app is not in the
   * connection map until its `Control` frame lands. The readiness gate lets
   * attach mode straight through, so the factory waits for that frame and the
   * first call of a session finds the app.
   */
  describe("before the provider has named its app", () => {
    it("serves the very first RPC once a prompt handshake lands", async () => {
      const agent = await startLentAgent({ handshakeDelayMs: 100 });
      publishDescriptor({ socketPath: agent.socketPath });

      const startedAt = Date.now();
      const instance = await instantiate();

      /** The frame ends the wait; the attach does not sit out the timeout. */
      expect(Date.now() - startedAt).toBeLessThan(NATIVE_DEVTOOLS_ATTACH_HANDSHAKE_TIMEOUT_MS / 2);

      /** No `waitForConnectedBundle`: the very first call must find the app. */
      expect(instance.api.isConnected(BUNDLE_ID)).toBe(true);
      await expect(
        instance.api.queryViewHierarchy(BUNDLE_ID, "ViewHierarchy.describeScreen")
      ).resolves.toEqual({ role: "AXWindow" });

      await instance.dispose();
      await agent.close();
    });

    /**
     * A provider with no app on offer yet must still attach and adopt the app
     * once it names one.
     */
    it(
      "attaches anyway when no handshake arrives in time, and adopts a late one",
      async () => {
        const agent = await startLentAgent({ deferHandshake: true });
        publishDescriptor({ socketPath: agent.socketPath });

        const startedAt = Date.now();
        const instance = await instantiate();
        const elapsed = Date.now() - startedAt;

        /**
         * The docs, `contract.ts` and the schema promise providers 2 seconds.
         */
        expect(NATIVE_DEVTOOLS_ATTACH_HANDSHAKE_TIMEOUT_MS).toBe(2_000);
        expect(elapsed).toBeGreaterThanOrEqual(NATIVE_DEVTOOLS_ATTACH_HANDSHAKE_TIMEOUT_MS - 50);
        expect(elapsed).toBeLessThan(NATIVE_DEVTOOLS_ATTACH_HANDSHAKE_TIMEOUT_MS + 1_000);
        expect(instance.api.listConnectedBundleIds()).toEqual([]);
        await expect(
          instance.api.queryViewHierarchy(BUNDLE_ID, "ViewHierarchy.describeScreen")
        ).rejects.toThrow(/not connected/);

        agent.handshake();
        await waitForConnectedBundle(instance.api);
        await expect(
          instance.api.queryViewHierarchy(BUNDLE_ID, "ViewHierarchy.describeScreen")
        ).resolves.toEqual({ role: "AXWindow" });

        await instance.dispose();
        await agent.close();
      },
      NATIVE_DEVTOOLS_ATTACH_HANDSHAKE_TIMEOUT_MS + 3_000
    );

    /** A service with a dead socket and no app would only fail every call. */
    it("fails the attach when the provider hangs up before naming an app", async () => {
      const agent = await startLentAgent({ deferHandshake: true });
      publishDescriptor({ socketPath: agent.socketPath });

      const attaching = instantiate();

      /** Let the dial land before hanging up on it. */
      while (agent.connections() === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      agent.hangUp();

      const error = await attaching.then(
        () => undefined,
        (reason: unknown) => reason
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/before the provider named the app/);
      expect(getFailureSignal(error)).toEqual({
        error_code: FAILURE_CODES.NATIVE_DEVTOOLS_ATTACH_LOST,
        error_kind: "network",
        failure_area: "tool_server",
        failure_stage: "native_devtools_attach",
      });

      await agent.close();
    });

    /**
     * Shutdown tears the service down while the factory waits and the registry
     * has no instance to dispose yet. Its abort is the only thing that reaches
     * the wait.
     */
    it("stops waiting and hangs up when the service is torn down", async () => {
      const agent = await startLentAgent({ deferHandshake: true });
      publishDescriptor({ socketPath: agent.socketPath });

      const teardown = new AbortController();
      const startedAt = Date.now();
      const attaching = instantiate(DEVICE_ID, teardown.signal);

      while (agent.connections() === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const hungUp = new Promise<void>((resolve) => agent.onPeerClosed(resolve));
      teardown.abort();

      await expect(attaching).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(NATIVE_DEVTOOLS_ATTACH_HANDSHAKE_TIMEOUT_MS / 2);
      await hungUp;

      await agent.close();
    });

    /**
     * The registry calls the factory with a live signal, but the factory awaits
     * the capability check before it subscribes. A teardown that lands during
     * that await must still end the attach.
     */
    it("gives up at once when the service is torn down before the factory subscribes", async () => {
      const agent = await startLentAgent({ deferHandshake: true });
      publishDescriptor({ socketPath: agent.socketPath });

      const registry = new Registry();
      registry.registerBlueprint(nativeDevtoolsBlueprint);
      const ref = nativeDevtoolsRef(resolveDevice(DEVICE_ID));

      const startedAt = Date.now();
      const attaching = registry.resolveService(ref.urn, ref.options);
      const disposing = registry.disposeService(ref.urn);

      await expect(attaching).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(NATIVE_DEVTOOLS_ATTACH_HANDSHAKE_TIMEOUT_MS / 2);

      await disposing;
      await agent.close();
    });
  });

  describe("network conditions", () => {
    const THROTTLE = {
      conditions: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      metroPort: 8081,
    };

    const cdpMethods = (agent: LentAgent) =>
      agent.received.filter((m) => m.type === "CDP").map((m) => m.payload.method);

    it("keeps the provider's network capture on when it removes the throttle", async () => {
      const agent = await startLentAgent();
      publishDescriptor({ socketPath: agent.socketPath });
      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);

      await instance.api.setNetworkConditions(BUNDLE_ID, THROTTLE);
      await instance.api.setNetworkConditions(BUNDLE_ID, null);

      expect(cdpMethods(agent)).toEqual([
        "NativeDevtoolsIos.getConditions",
        "NativeDevtoolsIos.configure",
        "Network.emulateNetworkConditions",
        "NativeDevtoolsIos.configure",
        "Network.enable",
      ]);

      await instance.dispose();
      await agent.close();
    });

    it("sends nothing to the provider on a reset with nothing set", async () => {
      const agent = await startLentAgent({ captureOn: false });
      publishDescriptor({ socketPath: agent.socketPath });
      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);

      await instance.api.setNetworkConditions(BUNDLE_ID, null);

      expect(cdpMethods(agent)).toEqual([]);

      await instance.dispose();
      await agent.close();
    });

    it("does not turn on, at a reset, the capture that a start found off", async () => {
      const agent = await startLentAgent({ captureOn: false });
      publishDescriptor({ socketPath: agent.socketPath });
      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);

      await expect(instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT)).resolves.toBe(false);
      await instance.api.setNetworkConditions(BUNDLE_ID, THROTTLE);
      await instance.api.setNetworkConditions(BUNDLE_ID, null);

      expect(cdpMethods(agent)).not.toContain("Network.enable");
      expect(cdpMethods(agent).at(-1)).toBe("Network.disable");

      await instance.dispose();
      await agent.close();
    });

    it("does not turn on, at a dispose, the capture that a start found off", async () => {
      const agent = await startLentAgent({ captureOn: false });
      publishDescriptor({ socketPath: agent.socketPath });
      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);

      await expect(instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT)).resolves.toBe(false);
      await instance.api.setNetworkConditions(BUNDLE_ID, THROTTLE);
      await instance.dispose();

      expect(cdpMethods(agent)).not.toContain("Network.enable");
      expect(cdpMethods(agent).at(-1)).toBe("Network.disable");
      await agent.close();
    });

    it("turns capture back off when the provider had it off", async () => {
      const agent = await startLentAgent({ captureOn: false });
      publishDescriptor({ socketPath: agent.socketPath });
      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);

      await instance.api.setNetworkConditions(BUNDLE_ID, THROTTLE);
      await instance.api.setNetworkConditions(BUNDLE_ID, null);

      expect(cdpMethods(agent).at(-1)).toBe("Network.disable");

      await instance.dispose();
      await agent.close();
    });

    it("remembers the provider's capture from before its first throttle", async () => {
      const agent = await startLentAgent({ captureOn: false });
      publishDescriptor({ socketPath: agent.socketPath });
      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);

      await instance.api.setNetworkConditions(BUNDLE_ID, THROTTLE);
      await instance.api.setNetworkConditions(BUNDLE_ID, { ...THROTTLE, metroPort: 8095 });
      await instance.api.setNetworkConditions(BUNDLE_ID, null);

      expect(cdpMethods(agent).at(-1)).toBe("Network.disable");

      await instance.dispose();
      await agent.close();
    });

    it("reads the provider's capture again after a reset", async () => {
      const agent = await startLentAgent({ captureOn: false });
      publishDescriptor({ socketPath: agent.socketPath });
      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);

      await instance.api.setNetworkConditions(BUNDLE_ID, THROTTLE);
      await instance.api.setNetworkConditions(BUNDLE_ID, null);
      agent.setCapture(true);
      await instance.api.setNetworkConditions(BUNDLE_ID, THROTTLE);
      await instance.api.setNetworkConditions(BUNDLE_ID, null);

      expect(cdpMethods(agent).at(-1)).toBe("Network.enable");

      await instance.dispose();
      await agent.close();
    });

    it("keeps capture on when the provider cannot report it", async () => {
      const agent = await startLentAgent({ captureOn: false, failsGetConditions: true });
      publishDescriptor({ socketPath: agent.socketPath });
      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);

      await instance.api.setNetworkConditions(BUNDLE_ID, THROTTLE);
      await instance.api.setNetworkConditions(BUNDLE_ID, null);

      expect(cdpMethods(agent).at(-1)).toBe("Network.enable");

      await instance.dispose();
      await agent.close();
    });

    /** The provider keeps the app connected, so the app's own reset on hang-up never runs. */
    it("removes its throttle from the app before it hangs up", async () => {
      const agent = await startLentAgent();
      publishDescriptor({ socketPath: agent.socketPath });
      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);
      await instance.api.setNetworkConditions(BUNDLE_ID, THROTTLE);

      await instance.dispose();

      expect(cdpMethods(agent).slice(-2)).toEqual([
        "NativeDevtoolsIos.configure",
        "Network.enable",
      ]);

      await agent.close();
    });

    it("clears a throttle the app refused before it hangs up", async () => {
      const agent = await startLentAgent({ refusesConditions: true });
      publishDescriptor({ socketPath: agent.socketPath });
      const instance = await instantiate();
      await waitForConnectedBundle(instance.api);
      await expect(instance.api.setNetworkConditions(BUNDLE_ID, THROTTLE)).rejects.toThrow(
        "rejected"
      );

      await instance.dispose();

      expect(cdpMethods(agent).slice(-2)).toEqual([
        "NativeDevtoolsIos.configure",
        "Network.enable",
      ]);

      await agent.close();
    });
  });

  it("refuses to inject when the provider granted the mechanism but lent no socket", async () => {
    publishDescriptor();

    await expect(instantiate()).rejects.toThrow(/published none/);
  });

  it("says so when the socket it published is not listening", async () => {
    publishDescriptor({ socketPath: path.join(temporaryDirectory, "absent.sock") });

    await expect(instantiate()).rejects.toThrow(/could not attach/);
  });

  /**
   * The simulator watcher polls `simctl` and resolves this blueprint by raw
   * UDID, with no tool call and no `ext:` id anywhere. A lookup keyed on the
   * `ext:` spelling leaves `lentSocketPath` undefined there and the factory
   * falls through to arming argent's own injection, overwriting the one the
   * provider already has in the app, which is the exact clobber the lent-agent
   * path exists to avoid.
   */
  describe("addressed by the raw udid, as the simulator watcher does", () => {
    it("attaches to the published socket", async () => {
      const agent = await startLentAgent();
      publishDescriptor({ socketPath: agent.socketPath });

      const instance = await instantiate(IOS_UDID);

      expect(instance.api.socketPath).toBe(agent.socketPath);
      expect(instance.api.isEnvSetup()).toBe(true);
      expect(instance.api.listConnectedBundleIds()).toEqual([BUNDLE_ID]);

      await instance.dispose();
      await agent.close();
    });

    it("refuses to inject when the provider lent no socket", async () => {
      publishDescriptor();

      await expect(instantiate(IOS_UDID)).rejects.toThrow(/published none/);
    });
  });

  /**
   * The `ext:` id and the raw udid name one app on one device, so both reach
   * one lent connection and one capture: a start under one name, then a read
   * or a stop under the other, sees what the start did.
   */
  describe("named by the ext: id and by the raw udid", () => {
    type Layer = { layer: string; armed: boolean; reason?: string };

    async function toolRegistry() {
      const { Registry, ServiceState } = await import("@argent/registry");
      const { createNetworkCaptureStartTool } =
        await import("../src/tools/network/network-capture-start");
      const { createNetworkCaptureStopTool } =
        await import("../src/tools/network/network-capture-stop");
      const { createNativeNetworkLogsTool } =
        await import("../src/tools/native-devtools/native-network-logs");
      const { createStopAllSimulatorServersTool } =
        await import("../src/tools/simulator/stop-all-simulator-servers");

      const registry = new Registry();
      registry.registerBlueprint(nativeDevtoolsBlueprint);
      registry.registerTool(createNetworkCaptureStartTool(registry));
      registry.registerTool(createNetworkCaptureStopTool(registry));
      registry.registerTool(createNativeNetworkLogsTool(registry));
      registry.registerTool(createStopAllSimulatorServersTool(registry));

      const nativeLayer = (result: { layers: Layer[] }) =>
        result.layers.find((layer) => layer.layer === "ios-native");
      const capture = async (tool: string, udid: string) =>
        nativeLayer(
          await registry.invokeTool<{ layers: Layer[] }>(tool, { udid, bundleId: BUNDLE_ID })
        );

      return {
        registry,
        start: (udid: string) => capture("network-capture-start", udid),
        stop: (udid: string) => capture("network-capture-stop", udid),
        header: async (udid: string) =>
          (
            await registry.invokeTool<{ header: string }>("native-network-logs", {
              udid,
              bundleId: BUNDLE_ID,
            })
          ).header,
        stopAll: (devices: string[]) =>
          registry.invokeTool<{ stopped: string[]; unmatched?: string[] }>(
            "stop-all-simulator-servers",
            { devices }
          ),
        liveNativeUrns: () =>
          [...registry.getSnapshot().services]
            .filter(
              ([urn, entry]) =>
                urn.startsWith("NativeDevtools:") && entry.state !== ServiceState.IDLE
            )
            .map(([urn]) => urn),
      };
    }

    it.each([
      { started: DEVICE_ID, other: IOS_UDID },
      { started: IOS_UDID, other: DEVICE_ID },
    ])(
      "reads and stops under $other the capture started under $started, over one connection",
      async ({ started, other }) => {
        const agent = await startLentAgent();
        publishDescriptor({ socketPath: agent.socketPath });
        const tools = await toolRegistry();

        expect(await tools.start(started)).toEqual({ layer: "ios-native", armed: true });
        expect(await tools.header(other)).toMatch(/^ios-native: armed, 0 requests/);
        // A start under the other name finds the capture on, over the same connection.
        expect(await tools.start(other)).toEqual({ layer: "ios-native", armed: true });
        expect(tools.liveNativeUrns()).toHaveLength(1);
        expect(agent.connections()).toBe(1);

        expect(await tools.stop(other)).toMatchObject({ layer: "ios-native", armed: false });
        expect(await tools.header(started)).toMatch(/^ios-native: stopped, 0 requests/);

        await tools.registry.dispose();
        await agent.close();
      }
    );

    it.each([DEVICE_ID, IOS_UDID])(
      "drops the one service on a stop-all-simulator-servers scoped to %s",
      async (scope) => {
        const agent = await startLentAgent();
        publishDescriptor({ socketPath: agent.socketPath });
        const tools = await toolRegistry();

        await tools.start(DEVICE_ID);
        await tools.start(IOS_UDID);
        const result = await tools.stopAll([scope]);

        expect(result.unmatched).toBeUndefined();
        expect(tools.liveNativeUrns()).toEqual([]);
        // Argent closed only its client connection: the provider's agent still runs.
        expect(result.stopped).toEqual([]);

        await tools.registry.dispose();
        await agent.close();
      }
    );
  });
});
