import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { scopeTempHome } from "../helpers/temp-home";

// The JS-runtime-debugger blueprint builds a real LogFileWriter, whose
// constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-metro-unattached-home-");

/**
 * A fresh tool-server and one Metro serving an iOS simulator and an Android
 * emulator. The simulator's app is not running yet, so Metro lists only the
 * emulator, and the first call names the simulator's logicalDeviceId, which
 * this process has never seen. It must not connect to the emulator, and once
 * the simulator's app attaches, the same id must reach it rather than a
 * session cached on the emulator.
 */

const SIMULATOR = {
  logicalDeviceId: "8e8a3f0c5b1d4e2f9a7c6b5d4e3f2a1b0c9d8e7f",
  deviceName: "iPhone 17 Pro",
};
const EMULATOR = {
  logicalDeviceId: "6661c0de5ab9d24f7e8a3b1c2d4e5f60718293a4",
  deviceName: "sdk_gphone64_arm64 - 14 - API 34",
};

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;
let listed = [EMULATOR];

function handleCDPMessage(ws: WebSocket, raw: string) {
  const { id, method } = JSON.parse(raw) as { id: number; method: string };
  ws.send(JSON.stringify({ id, result: method === "Debugger.enable" ? { debuggerId: "m" } : {} }));
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
            listed.map((d, i) => ({
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
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => handleCDPMessage(ws, raw.toString()));
    });

    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });

  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
});

afterAll(async () => {
  await registry.dispose();
  await new Promise<void>((resolve) => wss.close(() => mockServer.close(() => resolve())));
});

describe("a logicalDeviceId whose app is not on Metro yet (fresh tool-server)", () => {
  it("is refused instead of connecting to the only device, then reaches its own app once it attaches", async () => {
    await expect(
      registry.invokeTool("debugger-connect", {
        port: mockPort,
        device_id: SIMULATOR.logicalDeviceId,
      })
    ).rejects.toThrow(`"${SIMULATOR.logicalDeviceId}" is not attached to Metro`);

    listed = [EMULATOR, SIMULATOR];

    const connected = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: SIMULATOR.logicalDeviceId,
    })) as Record<string, unknown>;

    expect(connected.deviceName).toBe(SIMULATOR.deviceName);
    expect(connected.logicalDeviceId).toBe(SIMULATOR.logicalDeviceId);
  });
});
