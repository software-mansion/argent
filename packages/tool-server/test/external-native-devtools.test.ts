import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

let temporaryDirectory: string;

/**
 * Stands in for the provider: serves the agent's side of the wire, opening
 * with the `Control` frame that names the app it is lending.
 */
type LentAgent = {
  close: () => Promise<void>;
  hangUp: () => void;
  received: Array<{ type: string; payload: Record<string, unknown> }>;
  socketPath: string;
};

async function startLentAgent(): Promise<LentAgent> {
  const socketPath = path.join(temporaryDirectory, "agent.sock");
  const received: LentAgent["received"] = [];
  const sockets: net.Socket[] = [];

  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.write(JSON.stringify({ payload: { bundleId: BUNDLE_ID }, type: "Control" }) + "\n");

    readline.createInterface({ input: socket }).on("line", (raw) => {
      const message = JSON.parse(raw);
      received.push(message);

      /** Answer `ViewInspector` RPCs the way the agent in the app would. */
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

    const { nativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");

    await expect(
      nativeNetworkLogsTool.execute(
        { nativeDevtools: instance.api },
        { bundleId: "com.example.gone", clear: false, limit: 50, udid: DEVICE_ID }
      )
    ).rejects.toThrow(/not connected/);

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
});
