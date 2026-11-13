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

import { nativeDevtoolsBlueprint } from "../src/blueprints/native-devtools";
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
  hangUp: () => void;
  /** Sends the deferred `Control` frame of a `deferHandshake` agent. */
  handshake: () => void;
  /** Sends a CDP event, as the provider does with the app's network events. */
  sendEvent: (method: string, params: Record<string, unknown>) => void;
  /** Turns capture on or off, as the user can in the provider at any time. */
  setCaptureOn: (on: boolean) => void;
  received: Array<{ type: string; payload: Record<string, unknown> }>;
  socketPath: string;
};

async function startLentAgent(
  options: { deferHandshake?: boolean; captureOn?: boolean; conditionsError?: string } = {}
): Promise<LentAgent> {
  const socketPath = path.join(temporaryDirectory, "agent.sock");
  const received: LentAgent["received"] = [];
  const sockets: net.Socket[] = [];
  let captureOn = options.captureOn ?? true;

  const sendHandshake = (socket: net.Socket) =>
    socket.write(JSON.stringify({ payload: { bundleId: BUNDLE_ID }, type: "Control" }) + "\n");

  const server = net.createServer((socket) => {
    sockets.push(socket);
    if (!options.deferHandshake) sendHandshake(socket);

    readline.createInterface({ input: socket }).on("line", (raw) => {
      const message = JSON.parse(raw);
      received.push(message);

      /**
       * Answer CDP requests and `ViewInspector` RPCs the way the agent in the
       * app would. Its provider keeps capture on unless `captureOn` is false,
       * and answers the read of it with `conditionsError` when that is set.
       */
      if (message.type === "CDP") {
        const readsConditions = message.payload.method === "NativeDevtoolsIos.getConditions";
        const answer =
          readsConditions && options.conditionsError !== undefined
            ? { error: { message: options.conditionsError } }
            : {
                result: readsConditions
                  ? { enabled: captureOn, offline: false, latency: 2000 }
                  : {},
              };
        socket.write(
          JSON.stringify({ payload: { id: message.payload.id, ...answer }, type: "CDP" }) + "\n"
        );
      }
      if (message.type === "ViewInspector") {
        socket.write(
          JSON.stringify({
            payload: { id: message.payload.id, result: { role: "AXWindow" } },
            type: "ViewInspector",
          }) + "\n"
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    /** What a provider does when the app it was lending goes away. */
    hangUp: () => {
      for (const socket of sockets.splice(0)) socket.destroy();
    },
    handshake: () => {
      for (const socket of sockets) sendHandshake(socket);
    },
    sendEvent: (method, params) => {
      for (const socket of sockets) {
        socket.write(JSON.stringify({ payload: { method, params }, type: "CDP" }) + "\n");
      }
    },
    setCaptureOn: (on) => {
      captureOn = on;
    },
    received,
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

function instantiate(deviceId = DEVICE_ID) {
  const device = resolveDevice(deviceId);
  return nativeDevtoolsBlueprint.factory({}, device, { device });
}

/** The handshake lands a tick after connect. Wait for the app to show up. */
async function waitForConnectedBundle(api: {
  listConnectedBundleIds: () => string[];
}): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (api.listConnectedBundleIds().length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Without this the tests that assert an absence (no injection armed, no
   * termination) would pass on an attach that never happened.
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
    await waitForConnectedBundle(instance.api);

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
    await waitForConnectedBundle(instance.api);

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
    await waitForConnectedBundle(instance.api);

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
    await waitForConnectedBundle(instance.api);
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
    const { Registry } = await import("@argent/registry");
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
   */
  it("notes the missed launch on the first ok answer without advising a restart", async () => {
    const agent = await startLentAgent({ deferHandshake: true });
    publishDescriptor({ socketPath: agent.socketPath });

    const instance = await instantiate();
    await instance.api.startNetworkCapture(BUNDLE_ID, METRO_PORT);
    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { Registry } = await import("@argent/registry");
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
  });

  /**
   * A provider that has no app yet accepts us and hands the app over when its
   * agent arrives with the app's launch. We hear that app from its launch on,
   * so nothing was missed and the note must not say the launch was.
   */
  it("does not note a missed launch when the app's agent arrived after argent connected", async () => {
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
  });

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
    await waitForConnectedBundle(instance.api);

    const terminated = new Promise<void>((resolve) =>
      instance.events.on("terminated", () => resolve())
    );

    agent.hangUp();
    await terminated;

    /** A fresh resolve attaches again and re-adopts the app on offer. */
    const reattached = await instantiate();
    await waitForConnectedBundle(reattached.api);
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
    await waitForConnectedBundle(instance.api);

    let terminated = false;
    instance.events.on("terminated", () => {
      terminated = true;
    });

    await instance.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(terminated).toBe(false);

    await agent.close();
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
      await waitForConnectedBundle(instance.api);

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
});
