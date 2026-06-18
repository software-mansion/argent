import { describe, it, expect, vi, afterEach, type Mock } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { startMetroTool } from "../src/tools/simulator/start-metro";

function mockFetchSequence(...responses: string[]) {
  const fn = vi.fn();
  for (const body of responses) {
    fn.mockResolvedValueOnce({ text: async () => body });
  }
  // Any further calls keep returning the last response (readiness poll).
  if (responses.length) {
    const last = responses[responses.length - 1]!;
    fn.mockResolvedValue({ text: async () => last });
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

function fakeChild(pid: number | undefined) {
  return {
    pid,
    once: vi.fn(),
    removeListener: vi.fn(),
    unref: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("start-metro", () => {
  it("defaults to port 8081 and reuseExisting true", () => {
    expect(startMetroTool.zodSchema).toBeDefined();
    const parsed = startMetroTool.zodSchema!.parse({});
    expect(parsed.port).toBe(8081);
    expect(parsed.reuseExisting).toBe(true);
  });

  it("accepts a custom port and reuseExisting false", () => {
    const parsed = startMetroTool.zodSchema!.parse({ port: 9090, reuseExisting: false });
    expect(parsed.port).toBe(9090);
    expect(parsed.reuseExisting).toBe(false);
  });

  it("reuses a Metro instance already running on the port", async () => {
    mockFetchSequence("packager-status:running");
    (execFileSync as Mock).mockReturnValue("4242\n");

    const result = await startMetroTool.execute!({}, { port: 8081, reuseExisting: true });

    expect(result).toEqual({ status: "reused", port: 8081, pid: 4242 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts a new Metro when none is running and the port is free", async () => {
    // 1st probe (reuse check): not Metro. Readiness poll: running.
    mockFetchSequence("", "packager-status:running");
    (execFileSync as Mock).mockReturnValue(""); // no pids on port (pre-check + post-ready)
    (spawn as Mock).mockReturnValue(fakeChild(9999));

    const result = await startMetroTool.execute!({}, { port: 8081, reuseExisting: true });

    expect(result).toEqual({ status: "started", port: 8081, pid: 9999 });
    expect(spawn).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["react-native", "start", "--port", "8081"]),
      expect.objectContaining({ detached: true })
    );
  });

  it("looks up listening pids with the LISTEN-only filter (not client sockets)", async () => {
    mockFetchSequence("packager-status:running");
    (execFileSync as Mock).mockReturnValue("72129\n");

    const result = await startMetroTool.execute!({}, { port: 8081, reuseExisting: true });

    expect(result).toEqual({ status: "reused", port: 8081, pid: 72129 });
    // Must restrict to listeners, otherwise an established client socket on the
    // port (e.g. this tool-server's own keep-alive to Metro) would be returned.
    expect(execFileSync).toHaveBeenCalledWith(
      "lsof",
      ["-ti", "tcp:8081", "-sTCP:LISTEN"],
      expect.anything()
    );
  });

  it("started path reports the LISTEN-socket pid, not the spawn wrapper pid", async () => {
    mockFetchSequence("", "packager-status:running");
    // Pre-spawn non-Metro check: port free. Post-ready: real Metro listener.
    (execFileSync as Mock).mockReturnValueOnce("").mockReturnValue("14270\n");
    (spawn as Mock).mockReturnValue(fakeChild(14234)); // wrapper pid

    const result = await startMetroTool.execute!(
      {},
      { port: 8081, reuseExisting: true, command: "npx", args: ["expo", "start"] }
    );

    expect(result).toEqual({ status: "started", port: 8081, pid: 14270 });
  });

  it("runs a custom command verbatim without injecting --port/--projectRoot", async () => {
    mockFetchSequence("", "packager-status:running");
    (execFileSync as Mock).mockReturnValue("");
    (spawn as Mock).mockReturnValue(fakeChild(4321));

    const result = await startMetroTool.execute!(
      {},
      { port: 8081, reuseExisting: true, command: "npm", args: ["run", "start:local"] }
    );

    expect(result).toEqual({ status: "started", port: 8081, pid: 4321 });
    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["run", "start:local"],
      expect.objectContaining({ detached: true })
    );
  });

  it("errors when the port is held by a non-Metro process", async () => {
    mockFetchSequence("something else"); // /status is not Metro
    (execFileSync as Mock).mockReturnValue("1234\n5678\n");

    await expect(startMetroTool.execute!({}, { port: 8081, reuseExisting: true })).rejects.toThrow(
      /non-Metro/
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses to reuse when reuseExisting is false and Metro is already running", async () => {
    mockFetchSequence("packager-status:running");

    await expect(startMetroTool.execute!({}, { port: 8081, reuseExisting: false })).rejects.toThrow(
      /already running/
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
