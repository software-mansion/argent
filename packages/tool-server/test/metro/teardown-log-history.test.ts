/**
 * `stop-all-simulator-servers` reaps every device-owned service, and since the
 * `devices` scope landed that set includes `JsRuntimeDebugger`. Its dispose
 * calls `logWriter.close()`, which unlinks the console-log file — up to 50,000
 * captured entries.
 *
 * The deletion itself is fine: the next resolve builds a new writer over a new
 * path, so nothing could ever read the old file again. What was not fine is
 * that the victim's `debugger-log-registry` transparently reconnected and
 * reported `totalEntries: 0` with no error and no warning — indistinguishable
 * from an app that has logged nothing, which is the opposite conclusion.
 *
 * Drives the real Registry → JsRuntimeDebugger → debugger-log-registry path
 * against a mock Metro, disposing the service exactly as the teardown does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "node:fs";
import * as http from "node:http";
import { Registry, ServiceState } from "@argent/registry";
import {
  jsRuntimeDebuggerBlueprint,
  type JsRuntimeDebuggerApi,
} from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import { __resetReapedSessionsForTesting } from "../../src/utils/reaped-sessions";
import { TAIL_MAX } from "../../src/utils/debugger/log-file-writer";
import { scopeTempHome } from "../helpers/temp-home";

// The JS-runtime-debugger / network blueprints build a real LogFileWriter,
// whose constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-metro-teardown-log-home-");

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;
let appRunning = true;

const LOGICAL_ID = "logical-only-device";

function handleCDPMessage(ws: WebSocket, raw: string) {
  const { id } = JSON.parse(raw) as { id: number; method: string };
  ws.send(JSON.stringify({ id, result: {} }));
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
            appRunning
              ? [
                  {
                    id: "page-0",
                    title: "app (Test Device)",
                    description: "[C++ connection]",
                    webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=${LOGICAL_ID}&page=1`,
                    deviceName: "Test Device",
                    reactNative: {
                      logicalDeviceId: LOGICAL_ID,
                      capabilities: { prefersFuseboxFrontend: true },
                    },
                  },
                ]
              : []
          )
        );
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    });

    wss = new WebSocketServer({ server: mockServer });
    wss.on("connection", (ws) => ws.on("message", (raw) => handleCDPMessage(ws, raw.toString())));

    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });

  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
  registry.registerTool(createDebuggerLogRegistryTool(registry));
});

afterAll(async () => {
  await registry.dispose();
  await new Promise<void>((resolve) => wss.close(() => mockServer.close(() => resolve())));
});

beforeEach(async () => {
  // The registry caches the service, so a session a previous case left
  // connected would be reused — carrying its entry count into the next case.
  await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${LOGICAL_ID}`).catch(() => {});
  __resetReapedSessionsForTesting();
  appRunning = true;
});

async function connectAndCapture(deviceId: string, entries: number): Promise<string> {
  await registry.invokeTool("debugger-connect", { port: mockPort, device_id: deviceId });
  const urn = `JsRuntimeDebugger:${mockPort}:${deviceId}`;
  const api = await registry.resolveService<JsRuntimeDebuggerApi>(urn);
  for (let i = 0; i < entries; i++) {
    api.logWriter.write({
      id: i,
      timestamp: new Date(1710000000000 + i * 1000).toISOString(),
      level: "log",
      message: `captured ${i}`,
    });
  }
  expect(api.logWriter.getStats().totalEntries).toBe(entries);
  return urn;
}

describe("a debugger session reaped by stop-all-simulator-servers", () => {
  it("says the console history was deleted rather than reporting a silent app", async () => {
    const urn = await connectAndCapture(LOGICAL_ID, 60);
    const api = await registry.resolveService<JsRuntimeDebuggerApi>(urn);

    // Exactly what the teardown does to this device's debugger.
    await registry.disposeService(urn);
    expect(fs.existsSync(api.logWriter.getFilePath())).toBe(false);

    // The registry reconnects transparently — a brand new writer over a new
    // file. The count really is 0; the question is whether anything says why.
    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { totalEntries: number; note?: string };

    expect(result.totalEntries).toBe(0);
    expect(result.note).toBeDefined();
    expect(result.note).toContain("60 captured console entries");
    expect(result.note).toContain("stop-all-simulator-servers");
    expect(result.note).toContain("torn down");
  });

  it("stays silent when the previous session had captured nothing", async () => {
    // A teardown that destroyed no history has nothing to explain, and saying
    // otherwise would make every empty registry look like a lost one.
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: LOGICAL_ID });
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${LOGICAL_ID}`);

    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { totalEntries: number; note?: string };

    expect(result.totalEntries).toBe(0);
    expect(result.note).toBeUndefined();
  });

  it("does not attach the explanation to a registry that has its own entries", async () => {
    const urn = await connectAndCapture(LOGICAL_ID, 5);
    await registry.disposeService(urn);
    // Reconnect and capture fresh history before reading.
    await connectAndCapture(LOGICAL_ID, 3);

    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { totalEntries: number; note?: string };

    expect(result.totalEntries).toBe(3);
    expect(result.note).toBeUndefined();
  });

  it("reports the loss once, not on every later empty read", async () => {
    const urn = await connectAndCapture(LOGICAL_ID, 12);
    await registry.disposeService(urn);

    const first = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { note?: string };
    const second = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { note?: string };

    expect(first.note).toBeDefined();
    expect(second.note).toBeUndefined();
  });

  it("is dropped by an explicit debugger-connect, which starts a capture of its own", async () => {
    // The consumer is gated on an empty or not-connected read, so a breadcrumb
    // survives every read that finds entries — and would then attach "a teardown
    // ate your logs" to some later, unrelated empty read. An explicit connect
    // makes it wrong anyway: from there the capture is this session's own, so
    // empty honestly means nothing has been logged since. Same discipline as
    // the screen-recording and native-profiler starts.
    const urn = await connectAndCapture(LOGICAL_ID, 40);
    await registry.disposeService(urn);

    const connect = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { note?: string };

    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { totalEntries: number; note?: string };

    expect(connect.note).toBeUndefined();
    expect(result.totalEntries).toBe(0);
    expect(result.note).toBeUndefined();
  });

  describe("when the connect id and the logicalDeviceId differ", () => {
    // Every case above connects with LOGICAL_ID (the Chromium/Vega shape). On
    // iOS/Android the caller connects with a udid/serial and Metro echoes its
    // own logical id, so the disposer files one breadcrumb under both ids.
    const CONNECT_ID = "00000000-0000-0000-0000-0000000000ab";

    beforeEach(async () => {
      await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${CONNECT_ID}`).catch(() => {});
      __resetReapedSessionsForTesting();
    });

    it("explains the loss whichever of the two ids the read uses", async () => {
      const urn = await connectAndCapture(CONNECT_ID, 29);
      const api = await registry.resolveService<JsRuntimeDebuggerApi>(urn);
      // The premise: this really is the two-id shape, so both keys get written.
      expect(api.logicalDeviceId).toBe(LOGICAL_ID);
      expect(api.logicalDeviceId).not.toBe(CONNECT_ID);
      await registry.disposeService(urn);

      const viaConnectId = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: CONNECT_ID,
      })) as { totalEntries: number; note?: string };

      expect(viaConnectId.totalEntries).toBe(0);
      expect(viaConnectId.note).toContain("29 captured console entries");
    });

    it("spends BOTH breadcrumbs on that one read, so no copy outlives the event", async () => {
      // The read consumed one key and left the other, so a later unrelated
      // empty read — a fresh session that genuinely logged nothing — collected
      // the leftover and blamed a teardown that had already been explained.
      const urn = await connectAndCapture(CONNECT_ID, 7);
      await registry.disposeService(urn);

      const first = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: CONNECT_ID,
      })) as { note?: string };
      expect(first.note).toBeDefined();

      // The other spelling of the same device, and the same spelling again:
      // neither may still be holding a copy of that one teardown.
      const viaLogicalId = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: LOGICAL_ID,
      })) as { note?: string };
      const again = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: CONNECT_ID,
      })) as { note?: string };

      expect(viaLogicalId.note).toBeUndefined();
      expect(again.note).toBeUndefined();
    });

    it("drops BOTH breadcrumbs on an explicit connect, under either spelling", async () => {
      const urn = await connectAndCapture(CONNECT_ID, 11);
      await registry.disposeService(urn);

      await registry.invokeTool("debugger-connect", { port: mockPort, device_id: CONNECT_ID });

      for (const device_id of [CONNECT_ID, LOGICAL_ID]) {
        const result = (await registry.invokeTool("debugger-log-registry", {
          port: mockPort,
          device_id,
        })) as { note?: string };
        expect(result.note).toBeUndefined();
      }
    });
  });
});

describe("a debugger session whose app crashed", () => {
  async function crash(urn: string): Promise<string> {
    const api = await registry.resolveService<JsRuntimeDebuggerApi>(urn);
    appRunning = false;
    for (const ws of wss.clients) ws.terminate();
    await vi.waitFor(() =>
      expect(registry.getSnapshot().services.get(urn)?.state).toBe(ServiceState.ERROR)
    );
    return api.logWriter.getFilePath();
  }

  it("keeps the log file and names it on the not-connected read", async () => {
    const file = await crash(await connectAndCapture(LOGICAL_ID, 3));

    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { status: string; note?: string };

    expect(result.status).toBe("not_connected");
    expect(fs.readFileSync(file, "utf-8")).toContain("captured 2");
    expect(result.note).toContain(`kept at ${file}`);
    expect(result.note).not.toContain("stop-all-simulator-servers");
  });

  it("names the kept file on the next debugger-connect", async () => {
    const file = await crash(await connectAndCapture(LOGICAL_ID, 3));
    appRunning = true;

    const result = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { note?: string };

    expect(result.note).toContain(`kept at ${file}`);
  });

  it("names the kept file to a read by the logicalDeviceId of a udid connect", async () => {
    const CONNECT_ID = "00000000-0000-0000-0000-0000000000ab";
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${CONNECT_ID}`).catch(() => {});
    const file = await crash(await connectAndCapture(CONNECT_ID, 3));

    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { status: string; note?: string };

    expect(result.status).toBe("not_connected");
    expect(result.note).toContain(`kept at ${file}`);
  });

  it("reports the crash once when the connect id and the logicalDeviceId differ", async () => {
    const CONNECT_ID = "00000000-0000-0000-0000-0000000000ab";
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${CONNECT_ID}`).catch(() => {});
    const file = await crash(await connectAndCapture(CONNECT_ID, 3));

    const first = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: CONNECT_ID,
    })) as { status: string; note?: string };
    expect(first.status).toBe("not_connected");
    expect(first.note).toContain(`kept at ${file}`);

    appRunning = true;
    const emptyRead = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: CONNECT_ID,
    })) as { status: string; note?: string };
    const reconnect = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: CONNECT_ID,
    })) as { note?: string };

    expect(emptyRead.status).toBe("connected");
    expect(emptyRead.note).toBeUndefined();
    expect(reconnect.note).toBeUndefined();
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${CONNECT_ID}`);
  });
});

describe("debugger-log-registry tail", () => {
  beforeEach(async () => {
    // A session another case connected under a different id still answers to
    // LOGICAL_ID, so drop every debugger before reading this one.
    for (const urn of registry.getSnapshot().services.keys()) {
      if (urn.startsWith("JsRuntimeDebugger:")) await registry.disposeService(urn).catch(() => {});
    }
  });

  async function connectWith(
    entries: Array<{ level: string; message: string; url?: string }>
  ): Promise<void> {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: LOGICAL_ID });
    const api = await registry.resolveService<JsRuntimeDebuggerApi>(
      `JsRuntimeDebugger:${mockPort}:${LOGICAL_ID}`
    );
    entries.forEach(({ level, message, url }, i) =>
      api.logWriter.write({
        id: i,
        timestamp: new Date(1710000000000 + i * 1000).toISOString(),
        level,
        message,
        ...(url
          ? {
              stackTrace: {
                callFrames: [
                  { functionName: "f", scriptId: "1", url, lineNumber: 7, columnNumber: 0 },
                ],
              },
            }
          : {}),
      })
    );
  }

  type Entry = { level: string; message: string; sourceFile?: string; sourceLine?: number };
  const read = (extra: Record<string, unknown>) =>
    registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
      ...extra,
    }) as Promise<{ totalEntries: number; entries?: Entry[] }>;

  it("returns the newest entries inline, filtered by level", async () => {
    await connectWith(
      Array.from({ length: 6 }, (_, i) => ({
        level: i % 2 ? "warning" : "log",
        message: `entry ${i}`,
      }))
    );

    const result = await read({ tail: 2, levels: ["warning"] });

    expect(result.totalEntries).toBe(6);
    expect(result.entries?.map((e) => e.message)).toEqual(["entry 3", "entry 5"]);
  });

  it("returns every level when levels is left out", async () => {
    await connectWith([
      { level: "log", message: "a" },
      { level: "error", message: "b" },
      { level: "warning", message: "c" },
    ]);

    const result = await read({ tail: 2 });

    expect(result.entries?.map((e) => e.message)).toEqual(["b", "c"]);
  });

  it("keeps a message with a carriage return and names where it was logged", async () => {
    await connectWith([
      { level: "warning", message: "a\r\nb", url: "http://localhost:8081/src/app.js" },
    ]);

    const result = await read({ tail: 1 });

    expect(result.entries).toEqual([
      expect.objectContaining({ message: "a\r\nb", sourceFile: "src/app.js", sourceLine: 7 }),
    ]);
  });

  it("leaves entries out when tail is not passed", async () => {
    await connectWith([{ level: "log", message: "a" }]);
    expect((await read({})).entries).toBeUndefined();
  });

  it("filters by the error level the description uses as its example", async () => {
    await connectWith([
      { level: "log", message: "a" },
      { level: "error", message: "b" },
      { level: "warning", message: "c" },
    ]);

    const result = await read({ tail: 5, levels: ["error"] });

    expect(result.entries?.map((e) => e.message)).toEqual(["b"]);
  });

  it.each([
    ["an unknown level", { tail: 3, levels: ["warn"] }],
    ["a zero tail", { tail: 0 }],
    ["a fractional tail", { tail: 1.5 }],
    ["an empty levels list", { tail: 3, levels: [] }],
    ["levels without tail", { levels: ["warning"] }],
    ["a tail above the cap", { tail: TAIL_MAX + 1 }],
  ])("rejects %s instead of returning no entries", async (_, extra) => {
    await connectWith([{ level: "warning", message: "a" }]);
    await expect(read(extra)).rejects.toThrow();
  });
});
