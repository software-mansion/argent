import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";

/**
 * Vega's Metro is the *legacy* inspector-proxy, whose /json/list entries carry
 * no `reactNative` block at all — so no `logicalDeviceId`. The multi-device
 * guard added in #397 keys off `logicalDeviceId`, which means a Vega device is
 * invisible to it: it is neither matchable by device_id nor countable as a
 * device, so an unmatched Vega device_id would fall through to "pick the
 * priority target" and silently bind to whatever *other* app is on that Metro.
 *
 * The Vega payload below is copied verbatim from a live VVD
 * (amazon-6b8a76bae9485138 running the react-native-multi-tv-app-sample Debug
 * .vpkg) — including the second, unusable `vm: "don't use"` page the legacy
 * proxy always advertises alongside the real Hermes target.
 */

const VEGA_TARGETS = [
  {
    id: "0-1",
    description: "com.giolaq.multitv.vega",
    title: "Hermes React Native",
    type: "node",
    webSocketDebuggerUrl: "ws://[::1]:8081/inspector/debug?device=0&page=1",
    vm: "Hermes",
    deviceName: "kepler-device",
  },
  {
    id: "0--1",
    description: "com.giolaq.multitv.vega",
    title: "React Native Experimental (Improved Chrome Reloads)",
    type: "node",
    webSocketDebuggerUrl: "ws://[::1]:8081/inspector/debug?device=0&page=-1",
    vm: "don't use",
    deviceName: "kepler-device",
  },
];

// A modern (RN >= 0.76) device on the same Metro — the shape #397 already knows.
const IOS_TARGET = {
  id: "page-ios",
  title: "app (iPhone 16 Pro Max)",
  description: "[C++ connection]",
  webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=logical-ios&page=1",
  deviceName: "iPhone 16 Pro Max",
  reactNative: {
    logicalDeviceId: "logical-ios",
    capabilities: { prefersFuseboxFrontend: true },
  },
};

const VEGA_DEVICE_ID = "amazon-6b8a76bae9485138";

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;
let listTargets: unknown[] = [];

function handleCDPMessage(ws: WebSocket, raw: string) {
  const { id, method } = JSON.parse(raw) as { id: number; method: string };
  if (method === "Debugger.enable") {
    ws.send(JSON.stringify({ id, result: { debuggerId: "mock" } }));
    return;
  }
  ws.send(JSON.stringify({ id, result: {} }));
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    mockServer = http.createServer((req, res) => {
      if (req.url === "/status") {
        // Legacy Metro (RN 0.72) sends no X-React-Native-Project-Root.
        res.end("packager-status:running");
        return;
      }
      if (req.url === "/json/list") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(listTargets));
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    });
    wss = new WebSocketServer({ server: mockServer });
    wss.on("connection", (ws) => ws.on("message", (raw) => handleCDPMessage(ws, raw.toString())));
    mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => mockServer.close(() => resolve())));
});

// A debugger session is cached per `JsRuntimeDebugger:<port>:<device_id>`, so
// each scenario needs its own Registry or the second connect would silently
// reuse the first one's session instead of re-running target selection.
beforeEach(() => {
  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
});

afterEach(async () => {
  await registry.dispose();
});

describe("Vega target routing on a legacy Metro (no logicalDeviceId)", () => {
  it("connects to the Hermes target when the VVD is the only device", async () => {
    listTargets = VEGA_TARGETS;
    const res = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: VEGA_DEVICE_ID,
    })) as Record<string, unknown>;

    expect(res.deviceName).toBe("kepler-device");
    expect(res.appName).toBe("Hermes React Native");
    expect(res.isNewDebugger).toBe(false);
  });

  it("must NOT bind a Vega device_id to another device's runtime", async () => {
    // A VVD and an iPhone on the same Metro. The Vega device_id matches no
    // target by logicalDeviceId; without counting the Vega device, the guard
    // sees a single device and hands back the Fusebox (iOS) target — so
    // debugger-evaluate would run JS in the iPhone app.
    listTargets = [...VEGA_TARGETS, IOS_TARGET];

    await expect(
      registry.invokeTool("debugger-connect", { port: mockPort, device_id: VEGA_DEVICE_ID })
    ).rejects.toThrow(/No debugger target matches device_id/);
  });
});
