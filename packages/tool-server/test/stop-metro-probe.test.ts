import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

import {
  parseDarwinNetstatHasListener,
  procListeningPids,
  stopMetroTool,
} from "../src/tools/simulator/stop-metro";

const runStopMetro = (port: number) => stopMetroTool.execute({}, { port });

const originalPlatform = process.platform;
const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value, configurable: true });

const probeThrows = (fields: Record<string, unknown>) =>
  execFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error(String(fields.message)), fields);
  });

describe("stop-metro port probe", () => {
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    // The lsof path; the win32 and linux tests switch platform themselves.
    setPlatform("darwin");
    kill = vi.spyOn(process, "kill").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setPlatform(originalPlatform);
  });

  // lsof finds nothing it can see; netstat prints `netstatOutput`.
  const lsofFindsNothing = (netstatOutput: string) =>
    execFileSyncMock.mockImplementation((bin: string) => {
      if (bin.endsWith("netstat")) return netstatOutput;
      throw Object.assign(new Error("Command failed: lsof -ti tcp:8081 -sTCP:LISTEN"), {
        status: 1,
      });
    });
  // netstat answers, so a call that fails can only have failed on lsof.
  const lsofThrows = (fields: Record<string, unknown>) =>
    execFileSyncMock.mockImplementation((bin: string) => {
      if (bin.endsWith("netstat")) return NETSTAT_HEADER;
      throw Object.assign(new Error(String(fields.message)), fields);
    });
  const NETSTAT_HEADER =
    "Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)\n";

  it("reports stopped:false when lsof exits 1 and netstat lists no listener", async () => {
    lsofFindsNothing(
      NETSTAT_HEADER +
        "tcp4       0      0  127.0.0.1.8081         127.0.0.1.53412        ESTABLISHED\n" +
        "tcp46      0      0  *.18081                *.*                    LISTEN\n"
    );

    await expect(runStopMetro(8081)).resolves.toEqual({ stopped: false, port: 8081, pids: [] });
  });

  it("fails when lsof sees no listener but netstat lists one, e.g. another user's", async () => {
    lsofFindsNothing(
      NETSTAT_HEADER + "tcp46      0      0  *.8081                 *.*                    LISTEN\n"
    );

    await expect(runStopMetro(8081)).rejects.toThrow(
      "Could not determine what is listening on port 8081: no visible process owns a socket listening on port 8081: it belongs to another user, or just opened"
    );
    expect(kill).not.toHaveBeenCalled();
    const netstat = existsSync("/usr/sbin/netstat") ? "/usr/sbin/netstat" : "netstat";
    expect(execFileSyncMock.mock.calls[1].slice(0, 2)).toEqual([netstat, ["-an", "-p", "tcp"]]);
  });

  it("asks netstat only on macOS", async () => {
    setPlatform("freebsd");
    lsofFindsNothing(
      NETSTAT_HEADER + "tcp46      0      0  *.8081                 *.*                    LISTEN\n"
    );

    await expect(runStopMetro(8081)).resolves.toEqual({ stopped: false, port: 8081, pids: [] });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("fails when netstat cannot run after lsof exits 1", async () => {
    execFileSyncMock.mockImplementation((bin: string) => {
      throw Object.assign(new Error(`spawnSync ${bin} failed`), {
        status: bin.endsWith("netstat") ? 2 : 1,
      });
    });

    await expect(runStopMetro(8081)).rejects.toThrow(/netstat failed/);
  });

  it("fails instead of claiming the port is free when lsof is absent", async () => {
    lsofThrows({ message: "spawnSync lsof ENOENT", code: "ENOENT", status: null });

    await expect(runStopMetro(8081)).rejects.toThrow(
      "Could not determine what is listening on port 8081: spawnSync lsof ENOENT"
    );
  });

  it("fails instead of claiming the port is free when lsof exits 2", async () => {
    lsofThrows({ message: "Command failed: lsof -ti tcp:8081 -sTCP:LISTEN", status: 2 });

    await expect(runStopMetro(8081)).rejects.toThrow(
      "Could not determine what is listening on port 8081: Command failed: lsof -ti tcp:8081 -sTCP:LISTEN"
    );
  });

  it("fails instead of claiming the port is free when lsof times out", async () => {
    lsofThrows({ message: "spawnSync lsof ETIMEDOUT", code: "ETIMEDOUT", status: null });

    await expect(runStopMetro(8081)).rejects.toThrow(
      "Could not determine what is listening on port 8081: spawnSync lsof ETIMEDOUT"
    );
  });

  it("kills nothing when lsof prints something other than PIDs", async () => {
    execFileSyncMock.mockReturnValue(
      "1\t/bin/busybox\t0\t/dev/null\n9\t/bin/busybox\t1\tpipe:[1]\n"
    );

    await expect(runStopMetro(8081)).rejects.toThrow(
      "Could not determine what is listening on port 8081: lsof did not print a PID list: 1\t/bin/busybox\t0\t/dev/null"
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills every PID lsof reports", async () => {
    execFileSyncMock.mockReturnValue("4242\n4243\n");

    await expect(runStopMetro(8081)).resolves.toEqual({
      stopped: true,
      port: 8081,
      pids: [4242, 4243],
    });
    expect(kill.mock.calls).toEqual([
      [4242, "SIGTERM"],
      [4243, "SIGTERM"],
    ]);
  });

  it("runs lsof by absolute path, for listeners only", async () => {
    execFileSyncMock.mockReturnValue("4242\n");

    await runStopMetro(8081);

    const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].find((p) => existsSync(p)) ?? "lsof";
    expect(execFileSyncMock.mock.calls[0].slice(0, 2)).toEqual([
      lsof,
      ["-ti", "tcp:8081", "-sTCP:LISTEN"],
    ]);
  });

  it("fails when netstat exits non-zero on Windows", async () => {
    setPlatform("win32");
    probeThrows({ message: "Command failed: netstat -ano", status: 1 });

    await expect(runStopMetro(8081)).rejects.toThrow(
      "Could not determine what is listening on port 8081: Command failed: netstat -ano"
    );
  });

  it("reads procfs instead of running lsof on Linux", async () => {
    setPlatform("linux");
    execFileSyncMock.mockReturnValue("1\n");

    // Resolves or rejects depending on the host's real /proc; lsof must not run either way.
    await runStopMetro(8081).catch(() => {});

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalledWith(1, "SIGTERM");
  });
});

describe("parseDarwinNetstatHasListener", () => {
  it("matches a LISTEN row on the port for every address family", () => {
    for (const local of ["*.8081", "127.0.0.1.8081", "::1.8081"]) {
      expect(parseDarwinNetstatHasListener(`tcp4  0  0  ${local}  *.*  LISTEN`, 8081)).toBe(true);
    }
  });

  it("ignores other states, other ports and UDP", () => {
    expect(
      parseDarwinNetstatHasListener(
        [
          "tcp4  0  0  127.0.0.1.8081  127.0.0.1.53412  ESTABLISHED",
          "tcp4  0  0  *.18081  *.*  LISTEN",
          "tcp4  0  0  *.80810  *.*  LISTEN",
          "udp4  0  0  *.8081  *.*  LISTEN",
        ].join("\n"),
        8081
      )
    ).toBe(false);
  });
});

// Real row layout from /proc/net/tcp{,6}; port 8081 is 1F91, 18081 is 46A1.
const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const row = (local: string, remote: string, state: string, inode: number) =>
  `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

describe("procListeningPids", () => {
  let proc: string;

  const writeTable = (name: string, rows: string[]) =>
    writeFileSync(join(proc, "net", name), [HEADER, ...rows, ""].join("\n"));
  const addProcess = (pid: string, fds: Record<string, string>) => {
    mkdirSync(join(proc, pid, "fd"), { recursive: true });
    for (const [fd, target] of Object.entries(fds)) symlinkSync(target, join(proc, pid, "fd", fd));
  };

  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "stop-metro-proc-"));
    mkdirSync(join(proc, "net"));
  });
  afterEach(() => {
    rmSync(proc, { recursive: true, force: true });
  });

  it("returns the processes holding a socket that listens on the port", () => {
    writeTable("tcp", [
      row("0100007F:1F91", "00000000:0000", "0A", 111), // 127.0.0.1:8081 LISTEN
      row("0100007F:1F91", "0100007F:D431", "01", 222), // 127.0.0.1:8081 ESTABLISHED
      row("00000000:46A1", "00000000:0000", "0A", 333), // 0.0.0.0:18081 LISTEN
    ]);
    writeTable("tcp6", [
      row(
        "00000000000000000000000000000000:1F91",
        "00000000000000000000000000000000:0000",
        "0A",
        444
      ),
    ]);
    addProcess("100", { "0": "/dev/null", "21": "socket:[111]" });
    addProcess("200", { "5": "socket:[222]" });
    addProcess("300", { "5": "socket:[333]" });
    addProcess("400", { "7": "socket:[444]" });
    addProcess("500", { "3": "socket:[1111]", "4": "/tmp/socket:[111]" });
    addProcess("self", { "21": "socket:[111]" });
    mkdirSync(join(proc, "600")); // fd dir unreadable: another user's process

    expect(procListeningPids(8081, proc).sort()).toEqual([100, 400]);
  });

  it("returns nothing when no socket listens on the port", () => {
    writeTable("tcp", [row("00000000:46A1", "00000000:0000", "0A", 333)]);
    writeTable("tcp6", []);
    addProcess("300", { "5": "socket:[333]" });

    expect(procListeningPids(8081, proc)).toEqual([]);
  });

  it("works without a tcp6 table", () => {
    writeTable("tcp", [row("00000000:1F91", "00000000:0000", "0A", 111)]);
    addProcess("100", { "3": "socket:[111]" });

    expect(procListeningPids(8081, proc)).toEqual([100]);
  });

  it("fails instead of reporting the port free when its listener is not visible", () => {
    writeTable("tcp", [row("00000000:1F91", "00000000:0000", "0A", 111)]);
    writeTable("tcp6", []);
    mkdirSync(join(proc, "100"));

    expect(() => procListeningPids(8081, proc)).toThrow(
      "no visible process owns a socket listening on port 8081: it belongs to another user or PID namespace, or just closed"
    );
  });

  it("fails instead of reporting the port freed when one of its listeners is not visible", () => {
    writeTable("tcp", [
      row("0100007F:1F91", "00000000:0000", "0A", 111),
      row("0200007F:1F91", "00000000:0000", "0A", 222),
    ]);
    writeTable("tcp6", []);
    addProcess("100", { "3": "socket:[111]" });
    mkdirSync(join(proc, "200"));

    expect(() => procListeningPids(8081, proc)).toThrow(
      "no visible process owns a socket listening on port 8081"
    );
  });

  it("fails when the tcp6 table exists but cannot be read", () => {
    writeTable("tcp", []);
    mkdirSync(join(proc, "net", "tcp6"));

    expect(() => procListeningPids(8081, proc)).toThrow(/EISDIR/);
  });

  it("fails when the tcp table cannot be read", () => {
    expect(() => procListeningPids(8081, proc)).toThrow(/ENOENT.*net\/tcp/);
  });
});
