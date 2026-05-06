import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture per-test execSync stub so each case can supply its own netstat output.
const execSyncMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: (...args: Parameters<typeof actual.execSync>) => execSyncMock(...args),
  };
});

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function restorePlatform() {
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
}

// Real `netstat -ano -p TCP` output captured from a Windows host running Metro.
// Includes IPv4, IPv6, established connections (must be ignored), a non-Metro
// LISTENING row, and a duplicate PID across two address families.
const NETSTAT_FIXTURE = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1024",
  "  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       4321",
  "  TCP    0.0.0.0:49664          0.0.0.0:0              LISTENING       856",
  "  TCP    127.0.0.1:8081         127.0.0.1:55321        ESTABLISHED     4321",
  "  TCP    127.0.0.1:55321        127.0.0.1:8081         ESTABLISHED     9876",
  "  TCP    [::]:135               [::]:0                 LISTENING       1024",
  "  TCP    [::]:8081              [::]:0                 LISTENING       4321",
  "  TCP    [::1]:8082             [::]:0                 LISTENING       7777",
  "",
].join("\r\n");

describe("stop-metro findPidsListeningOnPort (Windows)", () => {
  let stopMetroTool: typeof import("../src/tools/simulator/stop-metro").stopMetroTool;
  // Capture process.kill calls so we can assert without actually killing
  // anything, and so a test PID never collides with a real OS process.
  const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

  beforeEach(async () => {
    vi.resetModules();
    execSyncMock.mockReset();
    killSpy.mockClear();
    setPlatform("win32");
    ({ stopMetroTool } = await import("../src/tools/simulator/stop-metro"));
  });

  afterEach(() => {
    restorePlatform();
  });

  it("invokes netstat -ano -p TCP on Windows", async () => {
    execSyncMock.mockReturnValue("");
    await stopMetroTool.execute!({}, { port: 8081 });
    expect(execSyncMock).toHaveBeenCalledOnce();
    expect(execSyncMock.mock.calls[0]![0]).toBe("netstat -ano -p TCP");
  });

  it("extracts the unique PID for Metro on port 8081 (LISTENING only, IPv4+IPv6 collapsed)", async () => {
    execSyncMock.mockReturnValue(NETSTAT_FIXTURE);
    const result = await stopMetroTool.execute!({}, { port: 8081 });
    // Both `0.0.0.0:8081` and `[::]:8081` LISTENING rows share PID 4321.
    // ESTABLISHED rows on :8081 (PID 9876 from the client side) must be
    // ignored — we only want the bundler process, not its clients.
    expect(result).toEqual({ stopped: true, port: 8081, pids: [4321] });
    expect(killSpy).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("returns stopped: false when no LISTENING row matches the port", async () => {
    execSyncMock.mockReturnValue(NETSTAT_FIXTURE);
    const result = await stopMetroTool.execute!({}, { port: 9999 });
    expect(result).toEqual({ stopped: false, port: 9999, pids: [] });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("does not match a substring (port 8081 must not match :80810 or :18081)", async () => {
    const fixture = [
      "  TCP    0.0.0.0:80810          0.0.0.0:0              LISTENING       1111",
      "  TCP    0.0.0.0:18081          0.0.0.0:0              LISTENING       2222",
      "",
    ].join("\r\n");
    execSyncMock.mockReturnValue(fixture);
    const result = await stopMetroTool.execute!({}, { port: 8081 });
    expect(result.pids).toEqual([]);
    expect(result.stopped).toBe(false);
  });

  it("returns empty pids when netstat throws (binary missing / non-zero exit)", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("'netstat' is not recognized");
    });
    const result = await stopMetroTool.execute!({}, { port: 8081 });
    expect(result).toEqual({ stopped: false, port: 8081, pids: [] });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("ignores ESTABLISHED rows even when local port matches", async () => {
    const fixture = [
      "  TCP    127.0.0.1:8081         127.0.0.1:55321        ESTABLISHED     5555",
      "",
    ].join("\r\n");
    execSyncMock.mockReturnValue(fixture);
    const result = await stopMetroTool.execute!({}, { port: 8081 });
    expect(result.pids).toEqual([]);
  });

  it("falls back to lsof on non-Windows platforms", async () => {
    restorePlatform();
    setPlatform("darwin");
    vi.resetModules();
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue("");
    const { stopMetroTool: posixTool } = await import("../src/tools/simulator/stop-metro");
    await posixTool.execute!({}, { port: 8081 });
    expect(execSyncMock).toHaveBeenCalledOnce();
    // On POSIX we use lsof, not netstat.
    expect(execSyncMock.mock.calls[0]![0]).toBe("lsof -ti tcp:8081");
  });
});
