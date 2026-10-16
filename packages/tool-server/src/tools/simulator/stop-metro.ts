import { z } from "zod";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import type { ToolDefinition } from "@argent/registry";

/**
 * Deduped PIDs *listening* on `port`, parsed out of `netstat -ano` (Windows).
 * Split out of `listeningPids` so the win32 row matching can be unit-tested
 * off Windows.
 *
 * A listener is identified by its wildcard foreign endpoint (`0.0.0.0:0` /
 * `[::]:0` / `*:*`), never by the State column, which Windows localizes
 * (German "ABHÖREN"). A connection in any other state has a real remote
 * endpoint there, so this also keeps the tool-server's own CDP client socket
 * to Metro out of the result. One listener can report the same PID on an IPv4
 * and an IPv6 row, hence the dedupe.
 */
export function parseNetstatListeningPids(netstatOutput: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of netstatOutput.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // cols: [proto, localAddr, foreignAddr, state, pid]
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
    // The colon guards against `:18081` matching port 8081.
    if (!cols[1].endsWith(`:${port}`)) continue;
    // Wildcard foreign endpoint, not the localized State text.
    const foreign = cols[2];
    if (foreign !== "*:*" && !foreign.endsWith(":0")) continue;
    // From the end, not a fixed index: a localized State can span several
    // whitespace-split tokens (French "À L'ÉCOUTE") and shift the column.
    const pid = parseInt(cols[cols.length - 1], 10);
    if (!Number.isNaN(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * PIDs *listening* on `port` on Linux, read from procfs: `net/tcp{,6}` rows in
 * the LISTEN state give the socket inodes, and the processes are the ones with
 * an fd linked to `socket:[<inode>]`. Linux hosts often lack a usable `lsof`
 * (absent from Debian, Ubuntu and Fedora base images, BusyBox on Alpine).
 */
export function procListeningPids(port: number, proc = "/proc"): number[] {
  const inodes = new Set<string>();
  for (const table of ["tcp", "tcp6"]) {
    let rows: string;
    try {
      rows = readFileSync(`${proc}/net/${table}`, "utf-8");
    } catch (error) {
      // No tcp6 table on a kernel without IPv6.
      if (table === "tcp6" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const line of rows.split("\n")) {
      // cols: [sl, localAddr, remAddr, state, tx:rx, tr:when, retrnsmt, uid, timeout, inode, ...]
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== "0A") continue; // 0A = TCP_LISTEN
      if (parseInt(cols[1].split(":")[1], 16) !== port) continue;
      inodes.add(cols[9]);
    }
  }
  if (inodes.size === 0) return [];

  const pids: number[] = [];
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`${proc}/${entry}/fd`);
    } catch {
      // Another user's process, or one that already exited.
      continue;
    }
    const owns = fds.some((fd) => {
      try {
        const target = readlinkSync(`${proc}/${entry}/fd/${fd}`);
        return inodes.has(target.match(/^socket:\[(\d+)\]$/)?.[1] ?? "");
      } catch {
        return false;
      }
    });
    if (owns) pids.push(parseInt(entry, 10));
  }
  if (pids.length === 0) {
    throw new Error(`no process visible to this user owns the socket listening on port ${port}`);
  }
  return pids;
}

/**
 * PIDs *listening* on a TCP port, cross-platform. Only the listener (Metro) is
 * returned, never a process holding an ESTABLISHED connection to the port:
 * that would match the tool-server's own CDP client socket to Metro.
 *
 * Windows parses `netstat -ano`, Linux reads procfs, and other hosts ask
 * `lsof`. Neither command runs through a shell, so `port` can never be read
 * as a shell token.
 */
function listeningPids(port: number): number[] {
  if (process.platform === "win32") {
    const output = execFileSync("netstat", ["-ano"], {
      encoding: "utf-8",
      timeout: 5_000,
      // `netstat -ano` dumps every socket on the host; Node's default 1 MiB
      // can overflow and fail the probe.
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseNetstatListeningPids(output, port);
  }
  if (process.platform === "linux") return procListeningPids(port);
  let output: string;
  try {
    output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
  } catch (error) {
    // lsof exits 1 when nothing is listening on the port.
    if ((error as { status?: unknown }).status === 1) return [];
    throw error;
  }
  if (!output) return [];
  const lines = output.split("\n").map((s) => s.trim());
  // Never SIGTERM the leading digits of a line that is not a bare PID.
  if (!lines.every((s) => /^\d+$/.test(s))) {
    throw new Error(`lsof did not print a PID list: ${lines[0]}`);
  }
  return lines.map((s) => parseInt(s, 10));
}

const zodSchema = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8081)
    .describe("TCP port Metro is listening on (default 8081)"),
});

export const stopMetroTool: ToolDefinition<
  { port: number },
  { stopped: boolean; port: number; pids: number[] }
> = {
  id: "stop-metro",
  interaction: {
    startedMsg: ({ params }) => `Stopping Metro on port ${params.port}`,
    completedMsg: ({ params }) => `Stopped Metro on port ${params.port}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to stop Metro on port ${params.port}: ${failureSignal.error_code}`,
  },
  description: `Stop the Metro bundler process listening on a given port (default 8081). Use when ending a React Native session or when Metro must be restarted. Returns { stopped, port, pids }; stopped=false if no process is found on the port. Fails if the port lookup cannot run, times out, or cannot identify the process listening on the port. This is DESTRUCTIVE: always ask the user for confirmation before calling this tool.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const port = (params as { port: number }).port;
    let pids: number[];
    try {
      pids = listeningPids(port);
    } catch (error) {
      throw new Error(
        `Could not determine what is listening on port ${port}: ${(error as Error).message}`,
        { cause: error }
      );
    }

    if (pids.length === 0) {
      return { stopped: false, port, pids: [] };
    }

    for (const pid of pids) {
      try {
        // Windows ignores the signal and terminates outright; on POSIX
        // SIGTERM lets Metro shut down cleanly.
        process.kill(pid, "SIGTERM");
      } catch {
        // Process may have already exited
      }
    }

    return { stopped: true, port, pids };
  },
};
