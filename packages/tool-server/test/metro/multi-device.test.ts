import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { FAILURE_CODES, Registry, getFailureSignal } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { scopeTempHome } from "../helpers/temp-home";

const SIM_B = "BBBBBBBB-0000-0000-0000-000000000000";
const SIM_C = "CCCCCCCC-0000-0000-0000-000000000000";
const SIM_C_NAMESAKE = "DDDDDDDD-0000-0000-0000-000000000000";
const SIM_E = "EEEEEEEE-0000-0000-0000-000000000000";
const namesFor = vi.hoisted(() =>
  vi.fn(async (deviceId: string) => {
    const name = (
      {
        "CCCCCCCC-0000-0000-0000-000000000000": "iPhone 15",
        "DDDDDDDD-0000-0000-0000-000000000000": "iPhone 15",
        "BBBBBBBB-0000-0000-0000-000000000000": "Pixel 9",
        "EEEEEEEE-0000-0000-0000-000000000000": "iPad Air",
        "99999999-0000-0000-0000-000000000000": "Galaxy S24",
      } as Record<string, string>
    )[deviceId.toUpperCase()];
    return name ? { name, forms: [name], booted: true, bootedTwins: 0 } : undefined;
  })
);
const noteHostedSimulatorOnMetro = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils/debugger/metro-device-name", () => ({
  metroDeviceNamesFor: namesFor,
  noteHostedSimulatorOnMetro,
}));
vi.mock("../../src/utils/external-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/external-devices")>()),
  assertExternalCapability: async () => {},
}));
vi.mock("../../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/sim-remote")>()),
  proxyStart: async () => {},
}));

// The JS-runtime-debugger / network blueprints build a real LogFileWriter,
// whose constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-metro-multidevice-home-");

/**
 * End-to-end regression for the "multiple debuggers all resolve to the same
 * device despite being passed different device_id" bug.
 *
 * Stands up a mock Metro whose /json/list reports TWO distinct devices (each
 * with its own logicalDeviceId + deviceName) on a single port, then drives the
 * real Registry → JsRuntimeDebugger blueprint → debugger-connect path.
 */

interface FakeDevice {
  logicalDeviceId: string;
  deviceName: string;
}

interface FakeMetro {
  port: number;
  close: () => Promise<void>;
}

let mockPort: number;
let metro: FakeMetro;
let registry: Registry;

const DEVICES: FakeDevice[] = [
  { logicalDeviceId: "logical-aaa", deviceName: "iPhone 16 Pro Max" },
  { logicalDeviceId: "logical-bbb", deviceName: "Pixel 9" },
  { logicalDeviceId: "logical-ccc", deviceName: "iPhone 15" },
  { logicalDeviceId: "logical-eee", deviceName: "iPad Air" },
];

function handleCDPMessage(ws: WebSocket, raw: string) {
  const { id, method } = JSON.parse(raw) as { id: number; method: string };
  switch (method) {
    case "Debugger.enable":
      ws.send(JSON.stringify({ id, result: { debuggerId: "mock" } }));
      ws.send(
        JSON.stringify({
          method: "Debugger.scriptParsed",
          params: {
            scriptId: "1",
            url: "http://localhost/index.bundle?platform=ios&dev=true",
            startLine: 0,
            endLine: 1,
            sourceMapURL: "index.bundle.map",
          },
        })
      );
      break;
    default:
      ws.send(JSON.stringify({ id, result: {} }));
  }
}

function listTargets(devices: FakeDevice[], port: number) {
  return devices.map((d, i) => ({
    id: `page-${i}`,
    title: `app (${d.deviceName})`,
    description: "[C++ connection]",
    webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=${d.logicalDeviceId}&page=1`,
    deviceName: d.deviceName,
    reactNative: {
      logicalDeviceId: d.logicalDeviceId,
      capabilities: { prefersFuseboxFrontend: true },
    },
  }));
}

async function startFakeMetro(devices: FakeDevice[]): Promise<FakeMetro> {
  let port = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.setHeader("X-React-Native-Project-Root", "/mock/project");
      res.end("packager-status:running");
      return;
    }
    if (req.url === "/json/list") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(listTargets(devices, port)));
      return;
    }
    res.statusCode = 404;
    res.end("Not found");
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => ws.on("message", (raw) => handleCDPMessage(ws, raw.toString())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  const close = () =>
    new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
  return { port, close };
}

function createRegistry(): Registry {
  const created = new Registry();
  created.registerBlueprint(jsRuntimeDebuggerBlueprint);
  created.registerTool(debuggerConnectTool);
  return created;
}

beforeAll(async () => {
  metro = await startFakeMetro(DEVICES);
  mockPort = metro.port;
  registry = createRegistry();
});

afterAll(async () => {
  await registry.dispose();
  await metro.close();
});

describe("multi-device debugger routing (mock Metro, two devices)", () => {
  it("routes each device_id to its own device", async () => {
    const a = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "logical-aaa",
    })) as Record<string, unknown>;
    const b = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "logical-bbb",
    })) as Record<string, unknown>;

    expect(a.deviceName).toBe("iPhone 16 Pro Max");
    expect(b.deviceName).toBe("Pixel 9");
    // The two connections must NOT collapse onto the same device.
    expect(a.logicalDeviceId).not.toBe(b.logicalDeviceId);
    expect(namesFor).not.toHaveBeenCalled();
  });

  it("rejects an unmatched device_id instead of silently picking the first device", async () => {
    await expect(
      registry.invokeTool("debugger-connect", { port: mockPort, device_id: "not-a-real-device" })
    ).rejects.toThrow(/No debugger target matches device_id "not-a-real-device"/);
  });

  it("resolves a simulator UDID to its own device by name", async () => {
    const c = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: SIM_C,
    })) as Record<string, unknown>;
    expect(c.logicalDeviceId).toBe("logical-ccc");
  });

  it("refuses a UDID whose app is already debugged under its logicalDeviceId", async () => {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "logical-bbb" });
    const error = await registry
      .invokeTool("debugger-connect", { port: mockPort, device_id: SIM_B })
      .catch((e: unknown) => e);
    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH);
    expect((error as Error).message).toContain(
      `already connected as "logical-bbb" on Metro port ${mockPort}. Pass device_id "logical-bbb"`
    );
  });

  it("lets only one of two overlapping connects to the same app through", async () => {
    const results = await Promise.allSettled([
      registry.invokeTool("debugger-connect", { port: mockPort, device_id: "logical-eee" }),
      registry.invokeTool("debugger-connect", { port: mockPort, device_id: SIM_E }),
    ]);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/already connected as/);
  });

  it("refuses another spelling of a UDID whose app already has a session", async () => {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: SIM_C });
    await expect(
      registry.invokeTool("debugger-connect", { port: mockPort, device_id: SIM_C.toLowerCase() })
    ).rejects.toThrow(`already connected as "${SIM_C}"`);
  });

  it("does not offer another device's live session to a same-named simulator", async () => {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: SIM_C });
    const error = await registry
      .invokeTool("debugger-connect", { port: mockPort, device_id: SIM_C_NAMESAKE })
      .catch((e: Error) => e);
    expect((error as Error).message).toMatch(/would evict that session/);
    expect((error as Error).message).not.toMatch(/Pass device_id/);
  });
});

describe("debugger routing on a Metro serving one device", () => {
  const SOLO = { logicalDeviceId: "logical-solo", deviceName: "Galaxy S24" };
  const SOLO_SIM = "99999999-0000-0000-0000-000000000000";
  const UNLISTED_SIM = "FFFFFFFF-0000-0000-0000-00000000abcd";
  let solo: FakeMetro;
  let soloRegistry: Registry;
  const connect = (device_id: string, port = solo.port) =>
    soloRegistry.invokeTool("debugger-connect", { port, device_id });
  const refusalOf = (device_id: string) => connect(device_id).catch((e: Error) => e.message);

  beforeEach(async () => {
    solo = await startFakeMetro([SOLO]);
    soloRegistry = createRegistry();
  });

  afterEach(async () => {
    await soloRegistry.dispose();
    await solo.close();
  });

  it("notes a hosted simulator's tunnel on the Metro it connects to", async () => {
    await connect("remote:AAAAAAAA-0000-0000-0000-000000000000");
    expect(noteHostedSimulatorOnMetro).toHaveBeenCalledWith(solo.port);
  });

  it("points a logicalDeviceId at the session its simulator's UDID holds", async () => {
    await connect(SOLO_SIM);
    // debugger-connect would follow the alias the finished connect learned;
    // a connect overlapping it still reaches the factory under its own id.
    const overlapping = soloRegistry
      .resolveService(`JsRuntimeDebugger:${solo.port}:logical-solo`)
      .catch((e: Error) => e.message);
    await expect(overlapping).resolves.toContain(
      `already connected as "${SOLO_SIM}" on Metro port ${solo.port}. Pass device_id "${SOLO_SIM}"`
    );
  });

  it("does not offer a logical-keyed session to a device reached by the fallback", async () => {
    await connect("logical-solo");
    const message = await refusalOf("emulator-5556");
    expect(message).toMatch(/would evict that session/);
    expect(message).not.toMatch(/Pass device_id/);
  });

  it("points a bare UDID at the session its ext: spelling holds", async () => {
    await connect(`ext:prov:${UNLISTED_SIM}`);
    await expect(refusalOf(UNLISTED_SIM)).resolves.toContain(
      `already connected as "ext:prov:${UNLISTED_SIM}" on Metro port ${solo.port}. ` +
        `Pass device_id "ext:prov:${UNLISTED_SIM}"`
    );
  });

  it("keeps a session on one Metro from blocking the same app on another", async () => {
    const other = await startFakeMetro([SOLO]);
    try {
      await connect("logical-solo");
      const result = (await connect(UNLISTED_SIM, other.port)) as Record<string, unknown>;
      expect(result.logicalDeviceId).toBe("logical-solo");
    } finally {
      await soloRegistry.dispose();
      await other.close();
    }
  });
});
