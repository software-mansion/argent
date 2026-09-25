import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { SimulatorServerApi } from "../src/blueprints/simulator-server";
import {
  fetchDisplayState,
  httpScreenshot,
  refreshActiveScreenForCapture,
  sendCommand,
} from "../src/utils/simulator-client";
import { __resetFoldableStateForTests, refreshActiveScreen } from "../src/utils/foldable";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

const DUO = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
const PANELS = [
  { screenId: 1, width: 1398, height: 2034 },
  { screenId: 3, width: 2007, height: 2853 },
];

/** CoreDevice reporting `active` for the given panel. */
function mockActivePanel(active: 1 | 3 | null): void {
  execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
    if (cmd === "xcode-select") return { stdout: "/Applications/Xcode.app/Contents/Developer\n" };
    if (active === null) return new Error("devicectl: no");
    if (cmd.endsWith("devicectl") || (cmd === "xcrun" && args[0] === "devicectl")) {
      return {
        stdout: JSON.stringify({
          result: {
            displays: PANELS.map((p) => ({
              active: p.screenId === active,
              displayId: p.screenId,
              nativeSize: [p.width, p.height],
              type: { integrated: {} },
            })),
          },
        }),
      };
    }
    return new Error(`unexpected ${cmd}`);
  });
}

/** A stand-in for simulator-server's `/ws` that acks every command and keeps it. */
async function startWs(): Promise<{
  port: number;
  received: Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const received: Record<string, unknown>[] = [];
  const sockets = new Set<WsSocket>();
  const wss = await new Promise<WebSocketServer>((resolve) => {
    const s: WebSocketServer = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () =>
      resolve(s)
    );
  });
  wss.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(msg);
      sock.send(JSON.stringify({ id: msg.id, status: "ok" }));
    });
  });
  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    received,
    close: async () => {
      for (const s of sockets) s.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

function apiFor(port: number, overrides: Partial<SimulatorServerApi> = {}): SimulatorServerApi {
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    streamUrl: `http://127.0.0.1:${port}/stream.mjpeg`,
    pressKey: () => Promise.resolve(),
    ...overrides,
  };
}

const TOUCH = { cmd: "touch", type: "Down", x: 0.3, y: 0.6, second_x: null, second_y: null };

beforeEach(() => {
  execFileMock.mockReset();
  __resetFoldableStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendCommand on a foldable", () => {
  it("names the live panel on touch and wheel, and on nothing else", async () => {
    const server = await startWs();
    try {
      mockActivePanel(3);
      await refreshActiveScreen(DUO);
      const api = apiFor(server.port, {
        deviceId: DUO,
        display: { foldable: true, panels: PANELS, hingeAngle: null },
      });
      await sendCommand(api, TOUCH);
      await sendCommand(api, { cmd: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 3 });
      await sendCommand(api, { cmd: "key", direction: "Down", code: 4 });
      await sendCommand(api, { cmd: "rotate", direction: "Portrait" });
      expect(server.received.map((m) => [m.cmd, m.screen])).toEqual([
        ["touch", 3],
        ["wheel", 3],
        ["key", undefined],
        ["rotate", undefined],
      ]);
    } finally {
      await server.close();
    }
  });

  it("reads the panel itself while the memo is empty, and falls back to the main screen when that fails", async () => {
    const server = await startWs();
    try {
      const api = apiFor(server.port, {
        deviceId: DUO,
        display: { foldable: true, panels: PANELS, hingeAngle: null },
      });
      // The attach-time read failed and nothing has read since: the touch
      // asks CoreDevice, which now answers.
      mockActivePanel(3);
      await sendCommand(api, TOUCH);
      expect(server.received[0]!.screen).toBe(3);
    } finally {
      await server.close();
    }
    const failing = await startWs();
    try {
      __resetFoldableStateForTests();
      const api = apiFor(failing.port, {
        deviceId: DUO,
        display: { foldable: true, panels: PANELS, hingeAngle: null },
      });
      mockActivePanel(null);
      await sendCommand(api, TOUCH);
      expect(failing.received[0]!.screen).toBe(1);
    } finally {
      await failing.close();
    }
  });

  it("completes a touch sequence on the panel it started on, whatever the memo says meanwhile", async () => {
    const server = await startWs();
    try {
      mockActivePanel(3);
      await refreshActiveScreen(DUO);
      const api = apiFor(server.port, {
        deviceId: DUO,
        display: { foldable: true, panels: PANELS, hingeAngle: null },
      });
      await sendCommand(api, TOUCH);
      // A fold made outside argent mid-swipe, seen by a recording's poll.
      mockActivePanel(1);
      await refreshActiveScreen(DUO);
      await sendCommand(api, { ...TOUCH, type: "Move", y: 0.4 });
      await sendCommand(api, { ...TOUCH, type: "Up", y: 0.3 });
      // The next touch sequence starts on the panel the device renders to now.
      await sendCommand(api, TOUCH);
      expect(server.received.map((m) => [m.type, m.screen])).toEqual([
        ["Down", 3],
        ["Move", 3],
        ["Up", 3],
        ["Down", 1],
      ]);
    } finally {
      await server.close();
    }
  });

  it("keeps a screen the caller named", async () => {
    const server = await startWs();
    try {
      mockActivePanel(3);
      await refreshActiveScreen(DUO);
      const api = apiFor(server.port, {
        deviceId: DUO,
        display: { foldable: true, panels: PANELS, hingeAngle: null },
      });
      await sendCommand(api, { ...TOUCH, screen: 1 });
      expect(server.received[0]!.screen).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("sends a device that is not foldable the payload it always sent", async () => {
    const server = await startWs();
    try {
      mockActivePanel(3);
      await refreshActiveScreen(DUO);
      const api = apiFor(server.port, { deviceId: DUO });
      await sendCommand(api, TOUCH);
      expect(server.received[0]).toEqual({ id: expect.any(String), ...TOUCH });
      expect(server.received[0]).not.toHaveProperty("screen");
    } finally {
      await server.close();
    }
  });
});

describe("httpScreenshot on a foldable", () => {
  function captureFetch() {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ url: "http://x/shot.png", path: "/tmp/shot.png" }),
        }) as unknown as Response
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("names the live panel in the request body, or the one the caller passed", async () => {
    mockActivePanel(3);
    await refreshActiveScreen(DUO);
    const fetchMock = captureFetch();
    const api = apiFor(4949, {
      deviceId: DUO,
      display: { foldable: true, panels: PANELS, hingeAngle: null },
    });
    await httpScreenshot(api);
    await httpScreenshot(api, undefined, undefined, 1.0, 1);
    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
    );
    expect(bodies[0]!.screen).toBe(3);
    expect(bodies[1]!.screen).toBe(1);
  });

  it("sends no screen for a device that is not foldable", async () => {
    const fetchMock = captureFetch();
    await httpScreenshot(apiFor(4949, { deviceId: DUO }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("screen");
  });
});

describe("refreshActiveScreenForCapture", () => {
  it("re-reads the panel and names it for a foldable, and stays silent otherwise", async () => {
    const api = apiFor(4949, {
      deviceId: DUO,
      display: { foldable: true, panels: PANELS, hingeAngle: null },
    });
    mockActivePanel(1);
    await refreshActiveScreen(DUO);
    mockActivePanel(3);
    const note = await refreshActiveScreenForCapture(api);
    expect(note).toContain("screen 3 (inner panel, 2007x2853)");
    // The capture that follows reads the refreshed memo.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ url: "u", path: "p" }),
        }) as unknown as Response
    );
    vi.stubGlobal("fetch", fetchMock);
    await httpScreenshot(api);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).screen).toBe(3);

    expect(await refreshActiveScreenForCapture(apiFor(4949, { deviceId: DUO }))).toBeUndefined();
  });

  it("says the read failed, and which panel is captured instead", async () => {
    const api = apiFor(4949, {
      deviceId: DUO,
      display: { foldable: true, panels: PANELS, hingeAngle: null },
    });
    mockActivePanel(null);
    const note = await refreshActiveScreenForCapture(api);
    expect(note).toContain("could not be read");
    expect(note).toContain("screen 1 (cover panel, 1398x2034)");
  });
});

describe("fetchDisplayState", () => {
  it("parses the server's display state and is null for a build without the route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ foldable: true, panels: PANELS, hingeAngle: 120 }),
          }) as unknown as Response
      )
    );
    expect(await fetchDisplayState(apiFor(4949))).toEqual({
      foldable: true,
      panels: PANELS,
      hingeAngle: 120,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response)
    );
    expect(await fetchDisplayState(apiFor(4949))).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    expect(await fetchDisplayState(apiFor(4949))).toBeNull();
  });
});
