import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { nameMatchedLogicalDeviceId } from "../../src/utils/debugger/device-name";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-metro-name-confirm-home-");

/**
 * A udid or serial matched by name, or by the pin an earlier match left, is
 * kept only when the runtime's own log shows it runs on that device. Mock
 * Metro serves two Android devices; each CDP socket answers the probe with the
 * logicalDeviceId it belongs to, and `findRuntimeDevices` maps that to the
 * serial the test says the app runs on.
 */

const { deviceNameMatcher, runsOn } = vi.hoisted(() => ({
  deviceNameMatcher: vi.fn(),
  /** logicalDeviceId -> the serials its runtime's log is found on. */
  runsOn: new Map<string, string[]>(),
}));

vi.mock("../../src/utils/debugger/device-name", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/debugger/device-name")>()),
  deviceNameMatcher,
}));
vi.mock("../../src/utils/debugger/runtime-device", () => ({
  findRuntimeDevices: async (cdp: { evaluate: (expression: string) => Promise<unknown> }) => {
    const logicalDeviceId = await cdp.evaluate("__probe");
    return { found: runsOn.get(String(logicalDeviceId)) ?? [], unresolved: [] };
  },
}));

const DEVICES = [
  { logicalDeviceId: "logical-api35", deviceName: "sdk_gphone64_arm64 - 15 - API 35" },
  { logicalDeviceId: "logical-api36", deviceName: "sdk_gphone64_arm64 - 16 - API 36" },
];

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;

function handleCDPMessage(ws: WebSocket, raw: string, logicalDeviceId: string | null) {
  const { id, method } = JSON.parse(raw) as { id: number; method: string };
  if (method === "Runtime.evaluate") {
    ws.send(JSON.stringify({ id, result: { result: { type: "string", value: logicalDeviceId } } }));
    return;
  }
  ws.send(JSON.stringify({ id, result: {} }));
}

const named = (name: string) => (reported: string) => reported === name;

async function connect(deviceId: string): Promise<Record<string, unknown>> {
  return (await registry.invokeTool("debugger-connect", {
    port: mockPort,
    device_id: deviceId,
  })) as Record<string, unknown>;
}

function freshRegistry(): void {
  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    mockServer = http.createServer((req, res) => {
      if (req.url === "/status") {
        res.setHeader("X-React-Native-Project-Root", "/mock/project");
        res.end("packager-status:running");
        return;
      }
      if (req.url === "/json/list") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            DEVICES.map((d, i) => ({
              id: `page-${i}`,
              title: `app (${d.deviceName})`,
              description: "[C++ connection]",
              webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=${d.logicalDeviceId}&page=1`,
              deviceName: d.deviceName,
              reactNative: {
                logicalDeviceId: d.logicalDeviceId,
                capabilities: { prefersFuseboxFrontend: true },
              },
            }))
          )
        );
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    });
    wss = new WebSocketServer({ server: mockServer });
    wss.on("connection", (ws, req) => {
      const device = new URL(req.url ?? "/", "http://localhost").searchParams.get("device");
      ws.on("message", (raw) => handleCDPMessage(ws, raw.toString(), device));
    });
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });
  freshRegistry();
});

afterEach(async () => {
  await registry.dispose();
  freshRegistry();
  deviceNameMatcher.mockReset();
  runsOn.clear();
});

afterAll(async () => {
  await registry.dispose();
  await new Promise<void>((resolve) => wss.close(() => mockServer.close(() => resolve())));
});

describe("a device matched by name", () => {
  it("connects and pins the match when the runtime's log is on the device", async () => {
    deviceNameMatcher.mockResolvedValue(named(DEVICES[0]!.deviceName));
    runsOn.set("logical-api35", ["emulator-5554"]);

    const result = await connect("emulator-5554");

    expect(result.logicalDeviceId).toBe("logical-api35");
    expect(nameMatchedLogicalDeviceId("emulator-5554", mockPort)).toBe("logical-api35");
    // Pins are per Metro port.
    expect(nameMatchedLogicalDeviceId("emulator-5554", mockPort + 1)).toBeUndefined();
  });

  it("refuses a twin with the same name that runs on another device", async () => {
    // emulator-5556's app is not on Metro yet; a device this host does not
    // list serves an app under the same name.
    deviceNameMatcher.mockResolvedValue(named(DEVICES[0]!.deviceName));
    runsOn.set("logical-api35", ["emulator-5600"]);

    await expect(connect("emulator-5556")).rejects.toThrow(
      /runs on emulator-5600, not on this device/
    );
    expect(nameMatchedLogicalDeviceId("emulator-5556", mockPort)).toBeUndefined();
  });

  it("refuses a match whose runtime no readable log holds", async () => {
    deviceNameMatcher.mockResolvedValue(named(DEVICES[0]!.deviceName));

    await expect(connect("emulator-5558")).rejects.toMatchObject({
      message: expect.stringMatching(/could not be confirmed to run on this device/),
    });
    expect(nameMatchedLogicalDeviceId("emulator-5558", mockPort)).toBeUndefined();
  });

  it("drops a pin whose serial now names another emulator, and matches by name again", async () => {
    // First boot: emulator-5560 is the API 35 AVD.
    deviceNameMatcher.mockResolvedValue(named(DEVICES[0]!.deviceName));
    runsOn.set("logical-api35", ["emulator-5560"]);
    expect((await connect("emulator-5560")).logicalDeviceId).toBe("logical-api35");
    await registry.dispose();
    freshRegistry();

    // The AVDs swapped ports: emulator-5560 is now the API 36 AVD.
    deviceNameMatcher.mockResolvedValue(named(DEVICES[1]!.deviceName));
    runsOn.clear();
    runsOn.set("logical-api35", ["emulator-5562"]);
    runsOn.set("logical-api36", ["emulator-5560"]);

    const result = await connect("emulator-5560");

    expect(result.logicalDeviceId).toBe("logical-api36");
    expect(nameMatchedLogicalDeviceId("emulator-5560", mockPort)).toBe("logical-api36");
  });

  it("does not probe a connect by logicalDeviceId", async () => {
    const result = await connect("logical-api36");
    expect(result.logicalDeviceId).toBe("logical-api36");
    expect(deviceNameMatcher).not.toHaveBeenCalled();
  });
});
