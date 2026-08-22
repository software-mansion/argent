/**
 * `stop-all-simulator-servers` reaps every device-owned service, and since the
 * `devices` scope landed that set includes `JsRuntimeDebugger`. Its dispose
 * closes the `LogFileWriter`, and on a teardown like this one — the app is
 * alive, nothing died — that unlinks the console-log file, up to 50,000
 * captured entries. (A teardown caused by the app itself going away keeps the
 * file instead; that path is covered in `log-survives-crash.test.ts`.)
 *
 * The deletion itself is fine: the next resolve builds a new writer over a new
 * path, so nothing could ever read this session's file again. What the victim's
 * `debugger-log-registry` must not do is reconnect transparently and report
 * `totalEntries: 0` with no error and no warning — indistinguishable from an
 * app that has logged nothing, which is the opposite conclusion.
 *
 * Drives the real Registry → JsRuntimeDebugger → debugger-log-registry path
 * against a mock Metro, disposing the service exactly as the teardown does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import {
  jsRuntimeDebuggerBlueprint,
  type JsRuntimeDebuggerApi,
} from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import { __resetReapedSessionsForTesting } from "../../src/utils/reaped-sessions";
import {
  canonicalDeviceId,
  isLogicalKeyedDevice,
  resetDeviceAliases,
} from "../../src/utils/debugger/device-alias";
import { scopeTempHome } from "../helpers/temp-home";

// The JS-runtime-debugger blueprints build a real LogFileWriter, whose
// constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-metro-teardown-log-home-");

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;

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
          JSON.stringify([
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
          ])
        );
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
  // Every session, not just this file's usual one: the registry caches them
  // across cases while `scopeTempHome` hands each case a new HOME, so one left
  // running answers the next case through a log file whose directory has since
  // been deleted — and carries its entry count over.
  for (const urn of registry.getSnapshot().services.keys()) {
    await registry.disposeService(urn).catch(() => {});
  }
  __resetReapedSessionsForTesting();
  // Module-global too, and the dispose above is what normally empties it - so
  // a case that fails before its own dispose would otherwise hand the next one
  // a learned alias.
  resetDeviceAliases();
});

async function connectAndCapture(deviceId: string, entries: number): Promise<string> {
  await registry.invokeTool("debugger-connect", { port: mockPort, device_id: deviceId });
  return capture(deviceId, entries);
}

/**
 * Capture without a `debugger-connect` — the way a read reaches a reaped
 * device, since resolving the service builds a new session on its own. A
 * connect would drop the breadcrumb before the read that is under test.
 */
async function capture(deviceId: string, entries: number): Promise<string> {
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

    // Exactly what the teardown does to this device's debugger.
    await registry.disposeService(urn);

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
    // The other half of the crash case's assertion: this teardown unlinked the
    // file, so the note must not offer a path — naming one here sends the
    // reader at a file that was deleted a line earlier.
    expect(result.note).toContain("no log file was left behind");
    expect(result.note).not.toContain(".log");
    // And it answers the question this tool's own empty answer raises. Only
    // here: `debugger-connect` and a `not_connected` result report the same
    // teardown with no registry to account for.
    expect(result.note).toContain("The counts here are the new session's own");
  });

  it("drops both ids it learned for the device when the session ends", async () => {
    // Four device_id descriptions and the alias map's own doc rest on this:
    // the key survives its session harmlessly, but the VALUE is the id the
    // caller connected with, so an alias outliving its session forwards a
    // later logicalDeviceId to a connection that is gone. The logical-keyed
    // marker is read by stop-all-simulator-servers, which would go on naming a
    // session that ended as one it left running.
    resetDeviceAliases();
    const udid = "dev-udid-0001";

    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: udid });
    expect(canonicalDeviceId(LOGICAL_ID)).toBe(udid);
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${udid}`);
    expect(canonicalDeviceId(LOGICAL_ID)).toBe(LOGICAL_ID);

    // The other half, which the alias has nothing to record: a connect whose id
    // IS the logicalDeviceId, the shape selectTarget demands on a shared Metro.
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: LOGICAL_ID });
    expect(isLogicalKeyedDevice(LOGICAL_ID)).toBe(true);
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${LOGICAL_ID}`);
    expect(isLogicalKeyedDevice(LOGICAL_ID)).toBe(false);
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
    // Implicitly, so the breadcrumb is still there to be wrongly attached: the
    // read below is what has to leave it alone, not a connect that dropped it.
    await capture(LOGICAL_ID, 3);

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
    // The consumer is gated on an EMPTY registry, so a breadcrumb survives every
    // read that finds entries — and would then attach "a teardown ate your logs"
    // to some later, unrelated empty read. An explicit connect makes it wrong
    // anyway: from there the capture is this session's own, so empty honestly
    // means nothing has been logged since. Same discipline as the
    // screen-recording and native-profiler starts.
    const urn = await connectAndCapture(LOGICAL_ID, 40);
    await registry.disposeService(urn);

    const connected = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { note?: string };

    // Silently. A runtime death's note carries a file path the agent still
    // needs, and a teardown that replaced an unread record is the only report
    // that record will get; this teardown is neither. It left no file, so saying
    // "torn down, possibly by another agent" here would answer a question this
    // caller did not ask, about a session it just replaced.
    expect(connected.note).toBeUndefined();

    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { totalEntries: number; note?: string };

    expect(result.totalEntries).toBe(0);
    expect(result.note).toBeUndefined();
  });

  describe("when the connect id and the logicalDeviceId differ", () => {
    // Every case above connects with LOGICAL_ID, so `api.logicalDeviceId ===
    // deviceId` and the disposer files one id rather than two — the Chromium
    // shape, where the two are one string by construction. Vega reaches the same
    // single key the other way: a legacy inspector reports no logicalDeviceId,
    // so the guard never pushes a second one. On iOS/Android the caller connects
    // with a udid/serial and Metro echoes its own logical id, so one teardown
    // writes two breadcrumbs. They describe one event and must be spent as one.
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

      // The other half of "whichever id": a fresh teardown, read back with the
      // id Metro echoed rather than the one the caller connected with. Reading
      // spends the whole event, so this needs its own teardown to read.
      __resetReapedSessionsForTesting();
      const second = await connectAndCapture(CONNECT_ID, 13);
      await registry.disposeService(second);

      const viaLogicalId = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: LOGICAL_ID,
      })) as { totalEntries: number; note?: string };

      expect(viaLogicalId.totalEntries).toBe(0);
      expect(viaLogicalId.note).toContain("13 captured console entries");
    });

    it("leaves the breadcrumb alone for a read that landed here by Metro's fallback", async () => {
      // `selectTarget` answers a device_id it cannot match with its single
      // remaining target instead of failing, so a read for some other device
      // resolves THIS device's session — logicalDeviceId included. Reading the
      // breadcrumb back under that id hands one device's lost history to
      // another as its own, and spends it, so the owner never sees it.
      const urn = await connectAndCapture(CONNECT_ID, 17);
      await registry.disposeService(urn);

      const strangerUrn = `JsRuntimeDebugger:${mockPort}:someone-elses-device`;
      const stranger = await registry.resolveService<JsRuntimeDebuggerApi>(strangerUrn);
      // The premise: the fallback really did land this session on the reaped
      // device's Metro target.
      expect(stranger.logicalDeviceId).toBe(LOGICAL_ID);

      const strangerRead = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: "someone-elses-device",
      })) as { totalEntries: number; note?: string };
      expect(strangerRead.totalEntries).toBe(0);
      expect(strangerRead.note).toBeUndefined();
      await registry.disposeService(strangerUrn);

      // Still there for the read it is actually about.
      const owner = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: CONNECT_ID,
      })) as { note?: string };
      expect(owner.note).toContain("17 captured console entries");
    });

    it("leaves the breadcrumb alone for a CONNECT that landed here by Metro's fallback", async () => {
      // The connect side of the same misresolve, and the costlier one: connect
      // spends the breadcrumb whatever its cause and reports only a runtime
      // death, so a teardown record it takes from another device is gone
      // without ever being printed.
      const urn = await connectAndCapture(CONNECT_ID, 23);
      await registry.disposeService(urn);

      const strangerUrn = `JsRuntimeDebugger:${mockPort}:someone-elses-device`;
      await registry.invokeTool("debugger-connect", {
        port: mockPort,
        device_id: "someone-elses-device",
      });
      const stranger = await registry.resolveService<JsRuntimeDebuggerApi>(strangerUrn);
      // The premise: the fallback really did land this connect on the reaped
      // device's Metro target.
      expect(stranger.logicalDeviceId).toBe(LOGICAL_ID);
      await registry.disposeService(strangerUrn);

      const owner = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: CONNECT_ID,
      })) as { note?: string };
      expect(owner.note).toContain("23 captured console entries");
    });

    it("keeps the reaped device's history when a stranger's session is torn down on it", async () => {
      // The write side of the same misresolve: the stranger's own teardown
      // files under the logicalDeviceId it borrowed, so a supersede on that one
      // shared id would drop the owner's breadcrumb before the owner read it,
      // and answer for a device the stranger's session never ran on.
      const urn = await connectAndCapture(CONNECT_ID, 23);
      await registry.disposeService(urn);

      const strangerUrn = `JsRuntimeDebugger:${mockPort}:someone-elses-device`;
      const stranger = await capture("someone-elses-device", 1);
      expect(
        (await registry.resolveService<JsRuntimeDebuggerApi>(strangerUrn)).logicalDeviceId
      ).toBe(LOGICAL_ID);
      await registry.disposeService(stranger);

      const owner = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: CONNECT_ID,
      })) as { note?: string };
      expect(owner.note).toContain("23 captured console entries");
      // And the stranger's own note must not claim the owner's record: the
      // owner kept a key of its own, so nothing of it went unreported.
      const strangerNote = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: "someone-elses-device",
      })) as { note?: string };
      expect(strangerNote.note).toContain("1 captured console entry");
      expect(strangerNote.note).not.toContain("earlier session");
    });

    it("spends BOTH breadcrumbs on that one read, so no copy outlives the event", async () => {
      // A read that consumed one key and left the other would leave a later
      // unrelated empty read — a fresh session that genuinely logged nothing —
      // collecting the leftover and blaming a teardown already explained.
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
