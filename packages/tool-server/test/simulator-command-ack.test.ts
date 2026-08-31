import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { sendCommand } from "../src/utils/simulator-client";
import type { SimulatorServerApi } from "../src/blueprints/simulator-server";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";

type Reply = "ok" | "error" | "silent" | "withhold";

/**
 * Stand-in for simulator-server's `/ws` command endpoint, mirroring the real
 * wire format: an accepted command is answered `{"id":"<echoed>","status":"ok"}`,
 * a rejected one `{"status":"error","message":"..."}` — with NO id, which is
 * why an error can only be matched against the oldest outstanding command.
 */
async function startServer(): Promise<{
  api: SimulatorServerApi;
  received: Record<string, unknown>[];
  setReply: (r: Reply) => void;
  /** Release every reply the server withheld, late and out of step. */
  flushWithheld: () => void;
  dropConnections: () => void;
  close: () => Promise<void>;
}> {
  const received: Record<string, unknown>[] = [];
  const sockets = new Set<WsSocket>();
  let reply: Reply = "ok";

  const wss = await new Promise<WebSocketServer>((resolve) => {
    const s: WebSocketServer = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () =>
      resolve(s)
    );
  });
  const withheld: (() => void)[] = [];
  wss.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(msg);
      if (reply === "ok") sock.send(JSON.stringify({ id: msg.id, status: "ok" }));
      else if (reply === "error")
        sock.send(JSON.stringify({ status: "error", message: "parse error: unknown variant" }));
      else if (reply === "withhold")
        withheld.push(() => sock.send(JSON.stringify({ id: msg.id, status: "ok" })));
    });
  });

  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    api: { apiUrl: `http://127.0.0.1:${port}`, streamUrl: "", pressKey: () => {} },
    received,
    setReply: (r) => {
      reply = r;
    },
    flushWithheld: () => {
      for (const send of withheld.splice(0)) send();
    },
    dropConnections: () => {
      for (const s of sockets) s.terminate();
    },
    // `sendCommand` caches one socket per apiUrl for the life of the process,
    // so the server has to hang up before `close()` can resolve; terminating
    // also evicts the cache entry, keeping each test on its own connection.
    close: async () => {
      for (const s of sockets) s.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

const TOUCH = {
  cmd: "touch",
  type: "Down",
  x: 0.5,
  y: 0.5,
  second_x: null,
  second_y: null,
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("sendCommand — command acknowledgement", () => {
  it("resolves once the server acks, and tags the command with the id it echoes", async () => {
    const server = await startServer();
    await expect(sendCommand(server.api, { ...TOUCH })).resolves.toBeUndefined();
    expect(server.received).toHaveLength(1);
    expect(server.received[0]).toMatchObject({ cmd: "touch", type: "Down" });
    expect(typeof server.received[0]!.id).toBe("string");
    await server.close();
  });

  it("rejects when the server answers `status: error` (an id-less reply)", async () => {
    const server = await startServer();
    server.setReply("error");
    const err = await sendCommand(server.api, { ...TOUCH }).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SIMULATOR_COMMAND_REJECTED);
    expect(String(err)).toContain("NOT delivered to the device");
    await server.close();
  });

  it("rejects in flight when the socket dies — the shut-the-simulator-down case", async () => {
    const server = await startServer();
    // Warm the connection so the next send goes out on an already-open socket.
    await sendCommand(server.api, { ...TOUCH });
    server.setReply("silent");
    const inFlight = sendCommand(server.api, { ...TOUCH }).catch((e: unknown) => e);
    server.dropConnections();
    expect(getFailureSignal(await inFlight)?.error_code).toBe(
      FAILURE_CODES.SIMULATOR_COMMAND_TRANSPORT_FAILED
    );
    await server.close();
  });

  it("rejects when a reachable server never answers, instead of hanging", async () => {
    const server = await startServer();
    await sendCommand(server.api, { ...TOUCH });
    server.setReply("silent");
    // Fake timers only after the socket is open, so no real I/O is stalled.
    vi.useFakeTimers();
    const inFlight = sendCommand(server.api, { ...TOUCH }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const signal = getFailureSignal(await inFlight);
    expect(signal?.error_code).toBe(FAILURE_CODES.SIMULATOR_COMMAND_ACK_TIMEOUT);
    expect(signal?.error_kind).toBe("timeout");
    vi.useRealTimers();
    await server.close();
  });

  it("never resolves a command that was refused — no phantom success", async () => {
    const server = await startServer();
    server.setReply("error");
    const outcomes = await Promise.allSettled([
      sendCommand(server.api, { ...TOUCH }),
      sendCommand(server.api, { ...TOUCH, type: "Up" }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
    await server.close();
  });
});

describe("gesture-tap — a lost tap is a failure, not `{ tapped: true }`", () => {
  it("reports success only when both touch events were acknowledged", async () => {
    const server = await startServer();
    const result = await gestureTapTool.execute(
      { simulatorServer: server.api } as never,
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", x: 0.5, y: 0.5 },
      undefined as never
    );
    expect(result.tapped).toBe(true);
    expect(server.received.map((m) => m.type)).toEqual(["Down", "Up"]);
    await server.close();
  });

  it("throws instead of claiming a tap the server rejected (#932 as a hard failure)", async () => {
    const server = await startServer();
    server.setReply("error");
    const err = await gestureTapTool
      .execute(
        { simulatorServer: server.api } as never,
        { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", x: 0.5, y: 0.5 },
        undefined as never
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SIMULATOR_COMMAND_REJECTED);
    // Bailed on the Down: the Up is never sent once the press is known lost.
    expect(server.received.map((m) => m.type)).toEqual(["Down"]);
    await server.close();
  });
});

describe("gesture-swipe — an aborted run still reports the abort", () => {
  it("keeps AbortError when the cleanup lift is refused, carrying it as `cause`", async () => {
    const server = await startServer();
    const controller = new AbortController();
    // Abort after the Down has landed, then refuse the lift: the abort is the
    // outcome callers key on by name, so it must survive the failed cleanup.
    let sends = 0;
    const abortAfterFirstSend = setInterval(() => {
      if (server.received.length > sends) {
        sends = server.received.length;
        server.setReply("error");
        controller.abort();
        clearInterval(abortAfterFirstSend);
      }
    }, 1);
    const err = await gestureSwipeTool
      .execute(
        { simulatorServer: server.api } as never,
        {
          udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
          fromX: 0.5,
          fromY: 0.7,
          toX: 0.5,
          toY: 0.3,
        },
        { signal: controller.signal } as never
      )
      .catch((e: unknown) => e);
    clearInterval(abortAfterFirstSend);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
    await server.close();
  });
});

describe("a late ack is never credited to a different command", () => {
  it("drops the reply to a timed-out command instead of settling the next one", async () => {
    const server = await startServer();
    await sendCommand(server.api, { ...TOUCH });

    // Command A is answered, but only after argent has given up on it.
    server.setReply("withhold");
    vi.useFakeTimers();
    const a = sendCommand(server.api, { ...TOUCH }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getFailureSignal(await a)?.error_code).toBe(FAILURE_CODES.SIMULATOR_COMMAND_ACK_TIMEOUT);
    vi.useRealTimers();

    // A's `{"id":"…","status":"ok"}` now lands. Command B must not inherit it:
    // crediting it would be the phantom success this change exists to remove.
    server.setReply("silent");
    let outcome = "pending";
    void sendCommand(server.api, { ...TOUCH, type: "Up" }).then(
      () => (outcome = "resolved"),
      () => (outcome = "rejected")
    );
    server.flushWithheld();
    await new Promise((r) => setTimeout(r, 50));

    // Rejected (the timed-out command tore the socket down) or still waiting on
    // its own ack — anything but resolved, which would mean B reported a
    // success that was really A's.
    expect(outcome).not.toBe("resolved");
    await server.close();
  });
});
