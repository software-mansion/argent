import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import { createDebuggerStatusTool } from "../../src/tools/debugger/debugger-status";
import { resolveDebuggerService } from "../../src/tools/debugger/not-connected";
import {
  __resetReapedSessionsForTesting,
  recordReapedSession,
} from "../../src/utils/reaped-sessions";
import { scopeTempHome } from "../helpers/temp-home";

/**
 * The console log file must outlive the app: when the CDP socket drops the
 * registry's terminated cascade disposes the debugger service, and the log
 * written before it dropped is exactly the artifact the developer came for.
 * What dropped it is not knowable from here — the app going away, the route to
 * it going away, and Metro handing the one debugger slot to someone else all
 * look the same — which is why the file has to survive all of them.
 */

// LogFileWriter mkdir -p's os.homedir()/.argent/tmp and this file asserts on
// that directory's contents, which is only meaningful when nothing else writes
// there — including the tool-server this developer may be running.
scopeTempHome("argent-log-crash-home-");

// One of the factory's hard-failure paths — the console-log server's bind,
// reached through `http.createServer`. Everything else here, this file's own
// mock Metro included, needs a working one, so the flag is off by default and
// flipped for exactly one call.
const httpControl = vi.hoisted(() => ({
  failCreateServer: false,
  /** Runs at the moment the bind fails, i.e. on the factory's way into its rollback. */
  onFail: undefined as (() => void) | undefined,
}));
// The other hard-failure path: a runtime that accepts the socket and then
// refuses a setup send, which production reaches as a request timeout against a
// frozen app.
const cdpControl = { failEnable: false };
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    default: actual,
    createServer: (...args: unknown[]) => {
      if (httpControl.failCreateServer) {
        httpControl.onFail?.();
        throw new Error("no sockets left");
      }
      return (actual.createServer as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const logDir = () => path.join(os.homedir(), ".argent", "tmp");

/**
 * Stop answering on the CDP socket and push console frames down it, until the
 * returned callback. `disconnect()` gives the far end a second to answer its
 * close frame and a server that has stopped reading never does, so whatever is
 * still listening for `consoleAPICalled` is exercised for that whole second —
 * the window in which the writer is already closed.
 */
function stallAndFlood(): () => void {
  const socket = cdpConn!;
  const raw = (socket as unknown as { _socket: { pause(): void; resume(): void } })._socket;
  raw.pause();
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "a frame after the close" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
  }, 5);
  return () => {
    clearInterval(timer);
    raw.resume();
  };
}

/** How many sockets opened since `known` are still up, once they have had time to drain. */
async function countLeakedSockets(known: Set<WebSocket>): Promise<number> {
  const opened = () => [...wss.clients].filter((socket) => !known.has(socket));
  for (let i = 0; i < 40 && opened().length > 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return opened().length;
}

let mockServer: http.Server;
let wss: WebSocketServer;
let cdpConn: WebSocket | null = null;
let mockPort: number;
/** A crashed app stops being listed by Metro, which is how the tools find out. */
let targetsGone = false;
let registry: Registry;

function handleCDPMessage(ws: WebSocket, raw: string) {
  const msg = JSON.parse(raw);
  const { id, method } = msg;
  if (cdpControl.failEnable && method === "Runtime.enable") {
    ws.send(JSON.stringify({ id, error: { code: -32000, message: "runtime is wedged" } }));
    return;
  }
  if (method === "Debugger.enable") {
    ws.send(JSON.stringify({ id, result: { debuggerId: "mock-debugger" } }));
    ws.send(
      JSON.stringify({
        method: "Debugger.scriptParsed",
        params: {
          scriptId: "1",
          url: "http://localhost/index.bundle?platform=ios&dev=true",
          startLine: 0,
          endLine: 50000,
        },
      })
    );
    return;
  }
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
        if (targetsGone) {
          res.end("[]");
          return;
        }
        res.end(
          JSON.stringify([
            {
              id: "page-1",
              title: "React Native (mock)",
              description: "[C++ connection]",
              webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=0&page=1`,
              deviceName: "MockDevice",
              reactNative: { capabilities: { prefersFuseboxFrontend: true } },
            },
          ])
        );
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    });

    wss = new WebSocketServer({ server: mockServer });
    wss.on("connection", (ws) => {
      cdpConn = ws;
      ws.on("message", (r) => handleCDPMessage(ws, r.toString()));
    });

    mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });

  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
  registry.registerTool(createDebuggerLogRegistryTool(registry));
  registry.registerTool(createDebuggerStatusTool(registry));
});

afterAll(async () => {
  await registry.dispose();
  cdpConn?.close();
  await new Promise<void>((resolve) => {
    wss.close(() => mockServer.close(() => resolve()));
  });
});

describe("console logs across an app crash", () => {
  // Every case opens its own session before it reaches for the socket, and the
  // handler above hands back whichever connected last. Cleared between cases so
  // a case that somehow does not open one terminates nothing rather than the
  // socket the case before it left behind.
  beforeEach(() => {
    cdpConn = null;
  });

  it("keeps the log file on disk when the CDP socket drops", async () => {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "mock-device" });

    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));

    const before = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "mock-device",
    })) as { file: string; totalEntries: number };

    expect(before.totalEntries).toBe(1);
    const logPath = before.file;
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");

    // The app dies: socket terminated server-side, no close handshake.
    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));

    // The file the tool already handed to the caller must still be readable.
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");

    fs.rmSync(logPath, { force: true });
  });

  it("points a post-crash reader at the file the crash left behind", async () => {
    // The half the surviving file does not fix on its own: an agent that only
    // calls `debugger-log-registry` AFTER the crash resolves a fresh session
    // and reads `totalEntries: 0`. The teardown breadcrumb is what stops that
    // being read as "the app logged nothing" — and because this teardown KEPT
    // the file, the breadcrumb has to name it rather than report a deletion.
    __resetReapedSessionsForTesting();
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "crash-note" });

    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));

    const { file: logPath } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "crash-note",
    })) as { file: string };

    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));

    const after = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "crash-note",
    })) as { totalEntries: number; file: string; note?: string };

    expect(after.totalEntries).toBe(0);
    expect(after.file).not.toBe(logPath);
    expect(after.note).toBeDefined();
    // The path, and a file actually there to be read at it.
    expect(after.note).toContain(logPath);
    // One entry, counted and worded as one.
    // A kept log runs to MAX_ENTRIES, so the note must not send an agent to read
    // the whole file.
    expect(after.note).toContain("grep that file for the 1 captured console entry it holds");
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");
    // The no-file arm belongs to a death that kept nothing; this one kept a
    // file, so the note has a path to name.
    expect(after.note).not.toContain("no log file was left behind");
    // And never the teardown family either. No tool was called and no other
    // agent was involved — the app crashed — so a note that opens by blaming a
    // stop-all sends the reader after a cause that does not exist, and does it
    // beside a salvage clause that only a dead runtime leaves behind.
    expect(after.note).toContain("its debugger connection dropped instead of being closed");
    expect(after.note).not.toContain("stop-all-simulator-servers");
    expect(after.note).not.toContain("another agent");

    fs.rmSync(logPath, { force: true });
  });

  it("names the kept file when the crashed app has dropped off Metro's target list", async () => {
    // What a crash actually looks like to the next tool call: the app is gone
    // from `/json/list`, so resolving a session fails and
    // `debugger-log-registry` answers `not_connected` instead of an empty
    // registry. That answer is the whole conversation — the breadcrumb is
    // consumed nowhere else on this path, and the guidance's restart-app leaves
    // no trace of the app that died — so it has to carry the path itself.
    __resetReapedSessionsForTesting();
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "gone-target" });
    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));
    const { file: logPath } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "gone-target",
    })) as { file: string };

    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));
    targetsGone = true;

    try {
      const after = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: "gone-target",
      })) as { status: string; reason: string; note?: string };

      expect(after.status).toBe("not_connected");
      expect(after.reason).toBe("no_app_connected");
      expect(after.note).toBeDefined();
      expect(after.note).toContain(logPath);
      expect(after.note).toContain("its debugger connection dropped instead of being closed");
      // The registry sentence belongs to an empty registry, and this answer has
      // none: it never resolved a session to read one from.
      expect(after.note).not.toContain("The counts here are the new session's own");
      expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");
    } finally {
      targetsGone = false;
      fs.rmSync(logPath, { force: true });
    }
  });

  it("reports a teardown that replaced an unread record, though it drops a plain one", async () => {
    // Dropping a plain teardown is deliberate: from this connect on the capture
    // is your own, and someone else's stop-all is not this session's business.
    // One that replaced an unread record is the only report that record will
    // get - reading it here is what destroys it, so dropping that one would
    // leave the loss reported nowhere.
    __resetReapedSessionsForTesting();
    const scope = String(mockPort);
    recordReapedSession("js-runtime-debugger", ["quiet-teardown"], "gone", {
      cause: "teardown",
      scope,
    });
    const plain = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "quiet-teardown",
    })) as { note?: string };
    expect(plain.note).toBeUndefined();

    recordReapedSession("js-runtime-debugger", ["replaced-crash"], "crash output", {
      cause: "runtime-death",
      scope,
    });
    recordReapedSession("js-runtime-debugger", ["replaced-crash"], "later teardown", {
      cause: "teardown",
      scope,
    });
    const replaced = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "replaced-crash",
    })) as { note?: string };
    expect(replaced.note).toContain("An earlier session that answered here");
  });

  it("reports the kept file from debugger-connect, the step crash recovery prescribes", async () => {
    // `debugger-connect` consumes the breadcrumb — deliberately, so a stale one
    // cannot explain some later unrelated empty read — and it is also exactly
    // where the crash-recovery guidance sends the agent (`debugger-status`'s
    // stale_connection guidance, and the "Was connected, then tool fails"
    // row of the skill's failure-scenarios reference, both say restart-app
    // then debugger-connect). Consuming it silently makes
    // the kept file unreachable: nothing else records the path, and the
    // reconnected session stops being empty — the one state
    // `debugger-log-registry` reports a breadcrumb in — as soon as the
    // relaunched app logs a line.
    __resetReapedSessionsForTesting();
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "reconnect-note" });
    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));
    const { file: logPath } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "reconnect-note",
    })) as { file: string };

    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));

    const reconnect = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "reconnect-note",
    })) as { note?: string };

    expect(reconnect.note).toBeDefined();
    expect(reconnect.note).toContain(logPath);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");

    fs.rmSync(logPath, { force: true });
  });

  it("keeps the log when debugger-status disposes the session in the CLOSING window", async () => {
    // The sibling teardown on the same dying runtime. `debugger-status`'s
    // stale_connection branch fires only when the socket has stopped being OPEN
    // and the close event has not dispatched yet — i.e. the far end has already
    // gone — and it disposes the service to force a fresh reconnect. Reading
    // just the `disconnected` event would call that an explicit teardown and
    // unlink the pre-crash log; the socket state is what makes it a death.
    //
    // The window is real but lasts a handful of microtasks, so it is held open
    // here at the seam the production code consults.
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "closing-device" });
    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));

    const before = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "closing-device",
    })) as { file: string; totalEntries: number };
    expect(before.totalEntries).toBe(1);

    const api = await resolveDebuggerService(registry, {
      port: mockPort,
      device_id: "closing-device",
    });
    const socketClosing = vi.spyOn(api.cdp, "isConnected").mockReturnValue(false);
    let reason: string | undefined;
    try {
      const status = (await registry.invokeTool("debugger-status", {
        port: mockPort,
        device_id: "closing-device",
      })) as { reason?: string };
      reason = status.reason;
    } finally {
      socketClosing.mockRestore();
    }

    expect(reason).toBe("stale_connection");
    expect(fs.existsSync(before.file)).toBe(true);
    expect(fs.readFileSync(before.file, "utf-8")).toContain("CRITICAL pre-crash error");

    // A kept file nothing names is barely better than a deleted one, and this
    // read is a health check, not the one an agent hunting logs makes. Spending
    // the breadcrumb here would take the path from the tool that reports it.
    const afterStatus = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "closing-device",
    })) as { note?: string };
    expect(afterStatus.note).toContain(before.file);

    fs.rmSync(before.file, { force: true });
  });

  it("keeps nothing when the app dies without having logged", async () => {
    // `keepFile` is gated on the same `captured` the breadcrumb is: a death that
    // captured nothing leaves an empty file that no breadcrumb names and that
    // the pruner only reclaims a day later — one per disconnect.
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "silent-device" });
    const { file } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "silent-device",
    })) as { file: string };
    expect(fs.existsSync(file)).toBe(true);

    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));

    expect(fs.existsSync(file)).toBe(false);
  });

  it("closes the log writer when the factory throws before a dispose exists", async () => {
    // Nothing else can close that writer — the factory never returns a dispose
    // — so an unclosed one leaves its file behind for good: the keepalive holds
    // it out of the sweep for as long as it runs. The absent file is the
    // observable end of `close()` from here; that it also frees the fd and the
    // keepalive is pinned on the writer itself, in log-file-writer.test.ts.
    fs.mkdirSync(logDir(), { recursive: true });
    const before = new Set(fs.readdirSync(logDir()));
    // By identity, not by count: sockets from earlier cases in this file can
    // still be draining, and a count calls a leaked one gone the moment one of
    // those drops.
    const socketsBefore = new Set(wss.clients);
    httpControl.failCreateServer = true;
    try {
      await expect(
        registry.invokeTool("debugger-connect", { port: mockPort, device_id: "throwing-device" })
      ).rejects.toThrow(/no sockets left/);
    } finally {
      httpControl.failCreateServer = false;
    }

    expect(fs.readdirSync(logDir()).filter((n) => !before.has(n))).toEqual([]);
    // The CDP socket the factory opened on the way here is the other thing
    // nothing would ever close.
    expect(await countLeakedSockets(socketsBefore)).toBe(0);
  });

  it("hands the CDP socket back when a setup send fails before the writer exists", async () => {
    // The factory owns this socket until it returns a dispose, and it never
    // returns one here. Left open, it holds a debugger target on Metro for the
    // life of the tool-server.
    fs.mkdirSync(logDir(), { recursive: true });
    const filesBefore = new Set(fs.readdirSync(logDir()));
    const socketsBefore = new Set(wss.clients);
    cdpControl.failEnable = true;
    try {
      await expect(
        registry.invokeTool("debugger-connect", { port: mockPort, device_id: "wedged-device" })
      ).rejects.toThrow(/runtime is wedged/);
    } finally {
      cdpControl.failEnable = false;
    }

    expect(await countLeakedSockets(socketsBefore)).toBe(0);
    // Nothing to close on this path — the failure lands before the writer is
    // built — so a new log file here would mean the order had drifted.
    expect(fs.readdirSync(logDir()).filter((n) => !filesBefore.has(n))).toEqual([]);
  });

  it("hands the CDP socket back when the log writer cannot be built", async () => {
    // The writer's constructor mkdir -p's ~/.argent/tmp, so a home the
    // tool-server cannot write there is a factory throw from the one setup step
    // that touches the filesystem — with the CDP socket open and, again, no
    // dispose coming to close it.
    const argentDir = path.join(os.homedir(), ".argent");
    fs.rmSync(argentDir, { recursive: true, force: true });
    fs.writeFileSync(argentDir, "a file where the directory goes");
    const socketsBefore = new Set(wss.clients);
    try {
      await expect(
        registry.invokeTool("debugger-connect", { port: mockPort, device_id: "homeless-device" })
      ).rejects.toThrow(/ENOTDIR/);
    } finally {
      fs.rmSync(argentDir, { force: true });
    }

    expect(await countLeakedSockets(socketsBefore)).toBe(0);
  });

  it("stops feeding the writer before the factory rollback closes it", async () => {
    // `LogFileWriter.write` throws once closed, and the rollback closes it and
    // then waits out a CDP close handshake with the client's message dispatch
    // still running — so a console listener left behind spends that window
    // writing to a closed writer. The emitter swallows what that throws, which
    // is what makes it worth pinning: nothing fails, it just prints.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // Read before the restore below, which clears the recorded calls with it.
    let noise: string;
    let stopFlood = () => {};
    httpControl.onFail = () => (stopFlood = stallAndFlood());
    httpControl.failCreateServer = true;
    try {
      await expect(
        registry.invokeTool("debugger-connect", { port: mockPort, device_id: "flooded-device" })
      ).rejects.toThrow(/no sockets left/);
    } finally {
      httpControl.failCreateServer = false;
      httpControl.onFail = undefined;
      stopFlood();
      noise = stderr.mock.calls.map((call) => String(call[0])).join("");
      stderr.mockRestore();
    }

    expect(noise).not.toContain("LogFileWriter is closed");
  });

  it("hands the console listener back when the session ends", async () => {
    // The same rule on the dispose path: the listener has to be gone before
    // `close()`, since the dispose goes on to file its breadcrumb and await two
    // shutdowns, and the runtime can send frames into all of it — which is what
    // the flood below sends it.
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "listener-device" });
    const api = await resolveDebuggerService(registry, {
      port: mockPort,
      device_id: "listener-device",
    });
    const consoleListeners = () =>
      (api.cdp.events as unknown as { listeners: Map<string, Set<unknown>> }).listeners.get(
        "consoleAPICalled"
      )?.size ?? 0;
    expect(consoleListeners()).toBe(1);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let noise: string;
    const stopFlood = stallAndFlood();
    try {
      await registry.disposeService(`JsRuntimeDebugger:${mockPort}:listener-device`);
    } finally {
      stopFlood();
      noise = stderr.mock.calls.map((call) => String(call[0])).join("");
      stderr.mockRestore();
    }

    expect(consoleListeners()).toBe(0);
    expect(noise).not.toContain("LogFileWriter is closed");
  });

  it("says there is no file at that path rather than sending a reader to grep it", async () => {
    // `open()` swallows its failure and buffers, so the counts and clusters are
    // real while `file` names a path that has never existed — and the documented
    // next step is to grep exactly that path.
    const logs = logDir();
    fs.mkdirSync(logs, { recursive: true });
    fs.chmodSync(logs, 0o555);
    try {
      await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "nofile-device" });

      // Before anything is logged: an unwritable directory shows up here first,
      // and an empty registry handing back a path is the same trap.
      const empty = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: "nofile-device",
      })) as { totalEntries: number; note?: string };
      expect(empty.totalEntries).toBe(0);
      expect(empty.note).toContain("There is no log file at");

      cdpConn!.send(
        JSON.stringify({
          method: "Runtime.consoleAPICalled",
          params: {
            type: "error",
            args: [{ type: "string", value: "buffered only" }],
            executionContextId: 1,
            timestamp: Date.now(),
          },
        })
      );
      await new Promise((r) => setTimeout(r, 200));

      const result = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: "nofile-device",
      })) as { totalEntries: number; file: string; note?: string };

      expect(result.totalEntries).toBe(1);
      expect(fs.existsSync(result.file)).toBe(false);
      expect(result.note).toContain("There is no log file at");
      expect(result.note).toContain(result.file);

      // And when that session dies, the breadcrumb has no file to keep either:
      // `keptAt` is gated on the writer having one, so the note reports the
      // loss instead of naming a path that never existed.
      cdpConn!.terminate();
      await new Promise((r) => setTimeout(r, 500));

      const afterDeath = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: "nofile-device",
      })) as { note?: string };
      expect(afterDeath.note).toContain("no log file was left behind");
      expect(afterDeath.note).not.toContain("has since been reclaimed");
      // And the new session's own file is still uncreatable, which the
      // breadcrumb says nothing about — the two are different files.
      expect(afterDeath.note).toContain("There is no log file at");
      // The breadcrumb leads. It is what says whose entries this answer's zero
      // is about; read the other way round, the sentence about this session's
      // missing path arrives before the reader knows the zero is not the dead
      // session's.
      expect(afterDeath.note!.indexOf("no log file was left behind")).toBeLessThan(
        afterDeath.note!.indexOf("There is no log file at")
      );
    } finally {
      fs.chmodSync(logs, 0o755);
    }
  });

  it("corrects the promise when the sweep took the file before anyone read the note", async () => {
    // The breadcrumb keeps the path apart from the prose so the read can check
    // it: a breadcrumb has no expiry and a kept log is swept once it is a day
    // old, so an unread one outlives what it advertises. Without the path on
    // the record there is nothing to check, and the note goes on telling the
    // reader to grep a file that is gone. The Chromium blueprint's twin is
    // asserted on the record itself; this is the Metro side of it.
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "swept-device" });
    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));

    const before = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "swept-device",
    })) as { file: string; totalEntries: number };
    expect(before.totalEntries).toBe(1);

    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(before.file)).toBe(true);

    // What the day-old sweep does to it, before anything reads the note.
    fs.rmSync(before.file, { force: true });

    const after = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "swept-device",
    })) as { note?: string };
    expect(after.note).toContain("has since been reclaimed");
    expect(after.note).not.toContain("grep that file");
  });

  it("reads the socket before the dispose awaits anything", async () => {
    // The read decides whether the file is kept, and the socket it reads is
    // closed by the `disconnect()` this same dispose awaits last of all. Moved
    // below that, an explicit teardown starts reporting itself as
    // a crash and keeping files nothing will ever reclaim but the pruner.
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "order-device" });
    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "logged before the teardown" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));

    const api = await resolveDebuggerService(registry, {
      port: mockPort,
      device_id: "order-device",
    });
    const { file } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "order-device",
    })) as { file: string };

    // A console-log subscriber, disconnected by `consoleServer.close()`: that
    // close cannot finish until this client has answered the close frame, so
    // its readyState tells the read which side of the await it ran on.
    const subscriber = new WebSocket(api.consoleSocketUrl);
    await new Promise<void>((resolve, reject) => {
      subscriber.on("open", () => resolve());
      subscriber.on("error", reject);
    });
    let subscriberAtRead = -1;
    // Reporting a live socket, so the teardown below stays a teardown.
    const connected = vi.spyOn(api.cdp, "isConnected").mockImplementation(() => {
      subscriberAtRead = subscriber.readyState;
      return true;
    });

    try {
      await registry.disposeService(`JsRuntimeDebugger:${mockPort}:order-device`);
    } finally {
      connected.mockRestore();
      subscriber.close();
    }

    expect(subscriberAtRead).toBe(WebSocket.OPEN);
    // And a live socket at that moment means a teardown, which takes the file.
    expect(fs.existsSync(file)).toBe(false);
    const after = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "order-device",
    })) as { note?: string };
    expect(after.note).toContain("no log file was left behind");
  });

  it("keys the breadcrumb by the port the session is named with", async () => {
    // `port` reaches the URN as text and the blueprint as a number, and the two
    // disagree on anything `parseInt` folds: `8081.5` is its own session, with
    // its own writer and its own log file, resolved on Metro 8081. Scoping the
    // breadcrumb by the parsed number would file it where this device's read
    // never looks.
    const spelling = mockPort + 0.5;
    await registry.invokeTool("debugger-connect", { port: spelling, device_id: "spelled-device" });
    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "CRITICAL pre-crash error" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));
    const { file: logPath } = (await registry.invokeTool("debugger-log-registry", {
      port: spelling,
      device_id: "spelled-device",
    })) as { file: string };

    cdpConn!.terminate();
    await new Promise((r) => setTimeout(r, 500));

    const after = (await registry.invokeTool("debugger-log-registry", {
      port: spelling,
      device_id: "spelled-device",
    })) as { note?: string };

    expect(after.note).toContain(logPath);

    fs.rmSync(logPath, { force: true });
  });

  it("removes the log file on an explicit teardown", async () => {
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: "explicit-device" });
    // With history in it: `keepFile` is a conjunction, so a session that
    // captured nothing is deleted by the other half and says nothing about
    // whether a teardown is told apart from a death.
    cdpConn!.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: "logged before the teardown" }],
          executionContextId: 1,
          timestamp: Date.now(),
        },
      })
    );
    await new Promise((r) => setTimeout(r, 200));
    const { file, totalEntries } = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: "explicit-device",
    })) as { file: string; totalEntries: number };
    expect(totalEntries).toBe(1);
    expect(fs.existsSync(file)).toBe(true);

    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:explicit-device`);

    expect(fs.existsSync(file)).toBe(false);
  });
});
