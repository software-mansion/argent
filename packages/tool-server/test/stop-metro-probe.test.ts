// Coverage for stop-metro's split between "the probe says nothing is listening"
// and "the probe never ran". Only the first may be answered with
// `stopped: false`, which is a positive claim that the port is free.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

import { stopMetroTool } from "../src/tools/simulator/stop-metro";

// Production spawns lsof by absolute path (LSOF_BIN); match on basename so the
// assertion holds wherever the binary lives.
const isLsof = (cmd: unknown): boolean =>
  typeof cmd === "string" && (cmd === "lsof" || cmd.endsWith("/lsof"));

const runStopMetro = (port: number) => stopMetroTool.execute({}, { port });

describe("stop-metro port probe", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports stopped:false when the probe exits non-zero, which is how lsof says the port is free", async () => {
    // A real non-zero exit carries a numeric `status`.
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("Command failed: lsof -ti tcp:8081 -sTCP:LISTEN"), {
        status: 1,
        signal: null,
      });
    });

    await expect(runStopMetro(8081)).resolves.toEqual({ stopped: false, port: 8081, pids: [] });
  });

  it("fails instead of claiming the port is free when the probe binary is absent", async () => {
    // spawnSync reports "could not run it at all" with a null `status` and an
    // errno code, which is exactly what a host without lsof produces.
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync /usr/sbin/lsof ENOENT"), {
        code: "ENOENT",
        status: null,
        signal: null,
        errno: -2,
      });
    });

    await expect(runStopMetro(8081)).rejects.toThrow(/port 8081.*lsof ENOENT/);
  });

  it("fails instead of claiming the port is free when the probe times out", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync /usr/sbin/lsof ETIMEDOUT"), {
        code: "ETIMEDOUT",
        status: null,
        signal: "SIGTERM",
        errno: -60,
      });
    });

    await expect(runStopMetro(8081)).rejects.toThrow(/port 8081.*ETIMEDOUT/);
  });

  it("kills the listener the probe reports", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      expect(isLsof(cmd)).toBe(true);
      return "4242\n";
    });

    await expect(runStopMetro(8081)).resolves.toEqual({
      stopped: true,
      port: 8081,
      pids: [4242],
    });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
  });
});
