import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { DeviceInfo } from "@argent/registry";
import { WebSocketServer } from "ws";
import { simulatorServerBlueprint } from "../src/blueprints/simulator-server";
import {
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  makeExternalId,
} from "../src/utils/external-devices";
import { httpScreenshot, sendCommand } from "../src/utils/simulator-client";
import { resolveDevice } from "../src/utils/device-info";

/**
 * The simulator-server blueprint's attach branch, against a stand-in speaking
 * the same wire protocol. It asserts the three things that are easy to get
 * wrong and invisible until they bite:
 *
 * 1. `dispose()` must not touch the provider's process,
 * 2. `pressKey` must travel over the WebSocket, because the local path uses
 *    stdin, which an attached server has none of, so `keyboard` would silently
 *    no-op,
 * 3. only the endpoints argent's own build serves may be used, however much
 *    the attached binary exposes. */

vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
  listIosSimulators: vi.fn(async () => []),
  getSimulatorRuntimeKind: vi.fn(async () => undefined),
  getCachedSimulatorRuntimeKind: vi.fn(() => undefined),
  cacheSimulatorRuntimeKind: vi.fn(),
  __resetSimulatorRuntimeKindCacheForTesting: vi.fn(),
}));

const IOS_UDID = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809";
const PROVIDER_ID = "acme-3f2a9c";
const DEVICE_ID = makeExternalId(PROVIDER_ID, IOS_UDID);

interface FakeSimulatorServer {
  alive: () => boolean;
  apiUrl: string;
  close: () => Promise<void>;
  /** Every HTTP path the server was asked for. */
  httpPaths: string[];
  streamUrl: string;
  /** Every WebSocket command frame the server received, in order. */
  wsCommands: unknown[];
}

/**
 * A stand-in for a simulator-server another process is running. It answers
 * only the endpoints argent's own build serves, so anything argent reaches for
 * beyond that shows up as a 404 in `httpPaths`, which is what makes the parity
 * rule checkable here as well as in the E2E.
 */
async function createFakeSimulatorServer(): Promise<FakeSimulatorServer> {
  const httpPaths: string[] = [];
  const wsCommands: unknown[] = [];
  let closed = false;

  const server = http.createServer((request, response) => {
    httpPaths.push(request.url ?? "");

    if (request.url === "/api/screenshot") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: "/tmp/shot.png", url: "file:///tmp/shot.png" }));
      return;
    }

    if (request.url === "/api/pointer") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  const webSocketServer = new WebSocketServer({ path: "/ws", server });

  webSocketServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      wsCommands.push(JSON.parse(String(data)));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    alive: () => !closed,
    apiUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
        /**
         * simulator-client keeps one long-lived WebSocket per `apiUrl`, so the
         * http server would never finish closing without terminating it first.
         */
        for (const client of webSocketServer.clients) client.terminate();
        webSocketServer.close();
        server.close(() => resolve());
      }),
    httpPaths,
    streamUrl: `http://127.0.0.1:${port}/stream.mjpeg`,
    wsCommands,
  };
}

let temporaryDirectory: string;
const cleanups: Array<() => Promise<void> | void> = [];

/**
 * Publish a descriptor offering `simulatorServer` as an iOS device, and return
 * the `DeviceInfo` argent would resolve for it.
 */
function attachTo(
  simulatorServer: FakeSimulatorServer,
  capabilities: string[] = ["ax-service", "simctl", "simulator-server"]
): DeviceInfo {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");

  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: [
        {
          capabilities,
          kind: "simulator",
          name: "iPhone 16 Pro",
          nativeId: IOS_UDID,
          platform: "ios",
          simulatorServer: {
            apiUrl: simulatorServer.apiUrl,
            streamUrl: simulatorServer.streamUrl,
            version: "1.20.0",
          },
          state: "Booted",
        },
      ],
      id: PROVIDER_ID,
      name: "Acme IDE",
      schemaVersion: 1,
      supportUrl: "https://example.invalid/issues",
    })
  );

  process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
  return resolveDevice(DEVICE_ID);
}

/**
 * Repoint the published descriptor at a different server, as a rebuild would.
 */
function republishAt(simulatorServer: FakeSimulatorServer): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));

  descriptor.devices[0].simulatorServer = {
    apiUrl: simulatorServer.apiUrl,
    streamUrl: simulatorServer.streamUrl,
  };

  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-attach-"));
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  __resetExternalDeviceCacheForTesting();
  __resetProviderWarningsForTesting();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function startSimulatorServer(): Promise<FakeSimulatorServer> {
  const simulatorServer = await createFakeSimulatorServer();
  cleanups.push(() => simulatorServer.close());
  return simulatorServer;
}

describe("attaching to a provider's simulator-server", () => {
  it("uses the published urls instead of spawning anything", async () => {
    const simulatorServer = await startSimulatorServer();
    const device = attachTo(simulatorServer);
    const instance = await simulatorServerBlueprint.factory({}, device, { device });
    expect(instance.api.apiUrl).toBe(simulatorServer.apiUrl);
    expect(instance.api.streamUrl).toBe(simulatorServer.streamUrl);
    expect(instance.api.external).toBe(true);
  });

  it("leaves the provider's process running when disposed", async () => {
    const simulatorServer = await startSimulatorServer();
    const device = attachTo(simulatorServer);
    const instance = await simulatorServerBlueprint.factory({}, device, { device });
    await instance.dispose();
    expect(simulatorServer.alive()).toBe(true);
  });

  /**
   * The whole reconnection story: the provider restarts its server on a new
   * ephemeral port and republishes, `recoverable()` disposes the old instance,
   * the registry re-runs the factory, and this read picks up the new port. No
   * reconnection code exists anywhere; it falls out of re-reading the file.
   */
  it("picks up a rebound port on the next instantiation", async () => {
    const originalServer = await startSimulatorServer();
    const device = attachTo(originalServer);
    const beforeRestart = await simulatorServerBlueprint.factory({}, device, { device });
    expect(beforeRestart.api.apiUrl).toBe(originalServer.apiUrl);

    const restartedServer = await startSimulatorServer();
    republishAt(restartedServer);
    const afterRestart = await simulatorServerBlueprint.factory({}, device, { device });
    expect(afterRestart.api.apiUrl).toBe(restartedServer.apiUrl);
    expect(afterRestart.api.apiUrl).not.toBe(originalServer.apiUrl);
  });

  it("sends key presses over the websocket, not stdin", async () => {
    const simulatorServer = await startSimulatorServer();
    const device = attachTo(simulatorServer);
    const instance = await simulatorServerBlueprint.factory({}, device, { device });
    instance.api.pressKey("Down", 0x04);
    instance.api.pressKey("Up", 0x04);
    await vi.waitFor(() => expect(simulatorServer.wsCommands).toHaveLength(2));
    expect(simulatorServer.wsCommands).toEqual([
      expect.objectContaining({ cmd: "key", direction: "Down", code: 0x04 }),
      expect.objectContaining({ cmd: "key", direction: "Up", code: 0x04 }),
    ]);
  });

  it("sends gestures over the websocket", async () => {
    const simulatorServer = await startSimulatorServer();
    const device = attachTo(simulatorServer);
    const instance = await simulatorServerBlueprint.factory({}, device, { device });
    sendCommand(instance.api, { cmd: "touch", type: "Down", x: 10, y: 20 });
    await vi.waitFor(() => expect(simulatorServer.wsCommands).toHaveLength(1));
    expect(simulatorServer.wsCommands[0]).toMatchObject({
      cmd: "touch",
      type: "Down",
      x: 10,
      y: 20,
    });
  });

  it("takes screenshots over the http api", async () => {
    const simulatorServer = await startSimulatorServer();
    const device = attachTo(simulatorServer);
    const instance = await simulatorServerBlueprint.factory({}, device, { device });
    await expect(httpScreenshot(instance.api)).resolves.toEqual({
      url: "file:///tmp/shot.png",
      path: "/tmp/shot.png",
    });
    expect(simulatorServer.httpPaths).toEqual(["/api/screenshot"]);
  });

  it("refuses paste rather than silently dropping it", async () => {
    const simulatorServer = await startSimulatorServer();
    const device = attachTo(simulatorServer);
    const instance = await simulatorServerBlueprint.factory({}, device, { device });
    expect(() => sendCommand(instance.api, { cmd: "paste", text: "hello" })).toThrow(
      /Pasting text is not available/
    );
    expect(simulatorServer.wsCommands).toHaveLength(0);
  });

  it("refuses an endpoint argent's own build does not serve", async () => {
    const simulatorServer = await startSimulatorServer();
    const device = attachTo(simulatorServer);
    const instance = await simulatorServerBlueprint.factory({}, device, { device });
    /**
     * Reaching past the parity allowlist must fail before any request is made,
     * so the provider's server never even sees it.
     */
    await expect(httpScreenshotAtEndpoint(instance.api, "/api/clipboard/text")).rejects.toThrow(
      /Refusing to call/
    );
    expect(simulatorServer.httpPaths).not.toContain("/api/clipboard/text");
  });

  it("refuses to attach when the provider withheld the simulator-server capability", async () => {
    const simulatorServer = await startSimulatorServer();
    const device = attachTo(simulatorServer, ["simctl"]);
    await expect(simulatorServerBlueprint.factory({}, device, { device })).rejects.toThrow(
      /'simulator-server' capability/
    );
  });
});

/**
 * Drive `simulatorPost`'s allowlist through its only public door. The
 * screenshot helper hard-codes its endpoint, so this mirrors what a future
 * caller reaching for a forbidden one would do.
 */
async function httpScreenshotAtEndpoint(
  api: { apiUrl: string; external?: boolean },
  endpoint: string
): Promise<unknown> {
  const { assertAllowedSimServerEndpoint } = await import("../src/utils/external-devices");
  if (api.external) assertAllowedSimServerEndpoint(endpoint);
  return fetch(`${api.apiUrl}${endpoint}`, { method: "POST" });
}
