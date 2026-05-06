import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture per-test execSync stub so each case can supply its own
// powershell / lsof output.
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

// `Get-NetTCPConnection -State Listen -LocalPort <port> | Select-Object
// -ExpandProperty OwningProcess` emits one PID per matching socket, one per
// line. A Metro listener bound on both IPv4 and IPv6 produces two lines with
// the same PID (we dedupe via Set in the resolver).
const POWERSHELL_DUAL_STACK = "4321\r\n4321\r\n";

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

  it("invokes powershell Get-NetTCPConnection on Windows", async () => {
    execSyncMock.mockReturnValue("");
    await stopMetroTool.execute!({}, { port: 8081 });
    expect(execSyncMock).toHaveBeenCalledOnce();
    const cmd = execSyncMock.mock.calls[0]![0] as string;
    // Locale-independent: we use Get-NetTCPConnection (returns enum-typed
    // results) instead of netstat (whose state column is localized on
    // non-English Windows — "ESCUCHANDO" / "ÉCOUTE" / etc., breaking any
    // regex anchored on "LISTENING").
    expect(cmd).toContain("powershell.exe");
    expect(cmd).toContain("Get-NetTCPConnection");
    expect(cmd).toContain("-State Listen");
    expect(cmd).toContain("-LocalPort 8081");
    expect(cmd).toContain("OwningProcess");
  });

  it("dedupes the PID when the listener appears on both IPv4 and IPv6", async () => {
    execSyncMock.mockReturnValue(POWERSHELL_DUAL_STACK);
    const result = await stopMetroTool.execute!({}, { port: 8081 });
    expect(result).toEqual({ stopped: true, port: 8081, pids: [4321] });
    expect(killSpy).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("returns stopped: false when powershell prints nothing", async () => {
    // -ErrorAction SilentlyContinue makes Get-NetTCPConnection print nothing
    // when there's no match; the wrapper exits 0 with empty stdout.
    execSyncMock.mockReturnValue("");
    const result = await stopMetroTool.execute!({}, { port: 9999 });
    expect(result).toEqual({ stopped: false, port: 9999, pids: [] });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("preserves the port number used in the powershell query", async () => {
    execSyncMock.mockReturnValue("");
    await stopMetroTool.execute!({}, { port: 19000 });
    const cmd = execSyncMock.mock.calls[0]![0] as string;
    // -LocalPort filtering happens server-side, so the port literal is what
    // anchors the match. Substring port collisions (e.g. 8081 inside 80810)
    // can't reach this layer because Get-NetTCPConnection already restricts
    // to exact-equality port matching.
    expect(cmd).toMatch(/-LocalPort 19000\b/);
  });

  it("returns empty pids when powershell throws (binary missing / non-zero exit)", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("'powershell.exe' is not recognized");
    });
    const result = await stopMetroTool.execute!({}, { port: 8081 });
    expect(result).toEqual({ stopped: false, port: 8081, pids: [] });
    expect(killSpy).not.toHaveBeenCalled();
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
    // On POSIX we still use lsof; the powershell branch is Windows-only.
    expect(execSyncMock.mock.calls[0]![0]).toBe("lsof -ti tcp:8081");
  });
});
