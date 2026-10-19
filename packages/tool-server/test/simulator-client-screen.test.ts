import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { SimulatorServerApi } from "../src/blueprints/simulator-server";
import {
  fetchDisplayState,
  httpScreenshot,
  resolveCapturePanel,
  sendCommand,
} from "../src/utils/simulator-client";
import { __resetFoldableStateForTests, setLivePanelSourceProvider } from "../src/utils/foldable";

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

/** The ax-service's `live_panel`, wired in the way the registry wires it. */
const livePanelMock = vi.fn<() => Promise<number | null>>();
const providerMock = vi.fn(async (_udid: string) => ({ livePanel: livePanelMock }));

function foldableApi(port: number): SimulatorServerApi {
  return apiFor(port, {
    deviceId: DUO,
    display: { foldable: true, panels: PANELS, hingeAngle: null },
  });
}

function spyStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}
let stderrSpy: ReturnType<typeof spyStderr>;
const stderrLines = (): string[] =>
  stderrSpy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes("[sim "));

beforeEach(() => {
  execFileMock.mockReset();
  livePanelMock.mockReset();
  providerMock.mockClear();
  setLivePanelSourceProvider(providerMock);
  __resetFoldableStateForTests();
  stderrSpy = spyStderr();
});

afterEach(() => {
  setLivePanelSourceProvider(undefined);
  stderrSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("sendCommand on a foldable", () => {
  it("names the live panel on a touch, and on nothing else", async () => {
    const server = await startWs();
    try {
      livePanelMock.mockResolvedValue(3);
      const api = foldableApi(server.port);
      expect(await sendCommand(api, TOUCH)).toEqual({});
      await sendCommand(api, { cmd: "key", direction: "Down", code: 4 });
      await sendCommand(api, { cmd: "rotate", direction: "Portrait" });
      expect(server.received.map((m) => [m.cmd, m.screen])).toEqual([
        ["touch", 3],
        ["key", undefined],
        ["rotate", undefined],
      ]);
      // Nothing was asked of CoreDevice: the ax-service answered.
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("asks CoreDevice when the ax-service cannot say, and falls back to the main screen with a warning", async () => {
    const server = await startWs();
    try {
      const api = foldableApi(server.port);
      livePanelMock.mockResolvedValue(null);
      mockActivePanel(3);
      expect(await sendCommand(api, TOUCH)).toEqual({});
      expect(server.received[0]!.screen).toBe(3);

      // A device left open, and nothing to say so: the cover panel, and the
      // tool hears why.
      mockActivePanel(null);
      const outcome = await sendCommand(api, { ...TOUCH, type: "Up" });
      expect(server.received[1]!.screen).toBe(3); // the sequence's Down chose it
      const fresh = await sendCommand(api, TOUCH);
      expect(server.received[2]!.screen).toBe(1);
      expect(outcome).toEqual({});
      expect(fresh.warning).toContain("could not be resolved");
      expect(fresh.warning).toContain("the accessibility service could not name the panel");
      expect(fresh.warning).toContain("this touch went to screen 1 (cover panel, 1398x2034)");
      expect(stderrLines()).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("completes a touch sequence on the panel it started on, whatever is live meanwhile", async () => {
    const server = await startWs();
    try {
      livePanelMock.mockResolvedValue(3);
      const api = foldableApi(server.port);
      await sendCommand(api, TOUCH);
      // A fold made outside argent mid-swipe.
      livePanelMock.mockResolvedValue(1);
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
      // Only the two Downs resolved.
      expect(livePanelMock).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("keeps a screen the caller named", async () => {
    const server = await startWs();
    try {
      livePanelMock.mockResolvedValue(3);
      await sendCommand(foldableApi(server.port), { ...TOUCH, screen: 1 });
      expect(server.received[0]!.screen).toBe(1);
      expect(livePanelMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("sends a device that is not foldable the payload it always sent, and asks nothing", async () => {
    const server = await startWs();
    try {
      livePanelMock.mockResolvedValue(3);
      const api = apiFor(server.port, { deviceId: DUO });
      expect(await sendCommand(api, TOUCH)).toEqual({});
      expect(server.received[0]).toEqual({ id: expect.any(String), ...TOUCH });
      expect(server.received[0]).not.toHaveProperty("screen");
      expect(providerMock).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
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
    livePanelMock.mockResolvedValue(3);
    const fetchMock = captureFetch();
    const api = foldableApi(4949);
    await httpScreenshot(api);
    await httpScreenshot(api, undefined, undefined, 1.0, 1);
    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
    );
    expect(bodies[0]!.screen).toBe(3);
    expect(bodies[1]!.screen).toBe(1);
    expect(livePanelMock).toHaveBeenCalledTimes(1);
  });

  it("sends no screen for a device that is not foldable", async () => {
    const fetchMock = captureFetch();
    await httpScreenshot(apiFor(4949, { deviceId: DUO }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("screen");
    expect(providerMock).not.toHaveBeenCalled();
  });
});

describe("resolveCapturePanel", () => {
  it("resolves the panel and names it for a foldable, and stays silent otherwise", async () => {
    livePanelMock.mockResolvedValue(3);
    const api = foldableApi(4949);
    const panel = await resolveCapturePanel(api);
    expect(panel?.screen).toBe(3);
    expect(panel?.note).toContain("renders to screen 3 (inner panel, 2007x2853)");
    expect(panel).not.toHaveProperty("warning");
    expect(await resolveCapturePanel(apiFor(4949, { deviceId: DUO }))).toBeUndefined();
    expect(livePanelMock).toHaveBeenCalledTimes(1);
  });

  it("says why the capture is of the main screen when nothing resolved the panel", async () => {
    livePanelMock.mockRejectedValue(new Error("ax-service not connected"));
    mockActivePanel(null);
    const panel = await resolveCapturePanel(foldableApi(4949));
    expect(panel?.screen).toBe(1);
    expect(panel?.note).toContain("could not be resolved (the accessibility service failed");
    expect(panel?.note).toContain("this capture is of screen 1 (cover panel, 1398x2034)");
    // The same text as a warning, for the results that carry only warnings.
    expect(panel?.warning).toBe(panel?.note);
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
