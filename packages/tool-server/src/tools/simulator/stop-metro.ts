import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolDefinition } from "@argent/registry";

// Absolute port probers, resolved once. A tool-server started from a GUI or
// launchd context inherits a PATH that can be missing `/usr/sbin`, and a bare
// name then ENOENTs. Bare name only when no canonical location exists.
const LSOF_BIN = ["/usr/sbin/lsof", "/usr/bin/lsof"].find((p) => existsSync(p)) ?? "lsof";
const NETSTAT_BIN =
  [`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\netstat.exe`].find((p) =>
    existsSync(p)
  ) ?? "netstat";

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
 * PIDs *listening* on a TCP port, cross-platform. Only the listener (Metro) is
 * returned, never a process holding an ESTABLISHED connection to the port —
 * that would match the tool-server's own CDP client socket to Metro.
 *
 * `lsof` exits non-zero when the port is free, and does not exist on Windows,
 * which parses `netstat -ano` instead. Neither runs through a shell, so `port`
 * can never be read as a shell token.
 */
function listeningPids(port: number): number[] {
  if (process.platform === "win32") {
    const output = execFileSync(NETSTAT_BIN, ["-ano"], {
      encoding: "utf-8",
      timeout: 5_000,
      // `netstat -ano` dumps every socket on the host; a busy box easily
      // exceeds Node's default 1 MiB, which would abort the probe.
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseNetstatListeningPids(output, port);
  }
  const output = execFileSync(LSOF_BIN, ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf-8",
    timeout: 5_000,
  }).trim();
  if (!output) return [];
  return output
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
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
  description: `Stop the Metro bundler process listening on a given port (default 8081). Use when ending a React Native session or when Metro must be restarted. Returns { stopped, port, pids }; stopped=false if no process is found on the port. Fails if the port lookup cannot run or times out, or the process cannot be killed. This is DESTRUCTIVE — always ask the user for confirmation before calling this tool.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const port = (params as { port: number }).port;
    try {
      const pids = listeningPids(port);

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
    } catch (error) {
      // A non-zero exit is how the probe reports "nothing is listening". Any
      // other failure (absent binary, timeout, overflowed output) never read
      // the port, so it must not be answered with the positive claim
      // `stopped: false`.
      if (typeof (error as { status?: unknown }).status === "number") {
        return { stopped: false, port, pids: [] };
      }
      throw new Error(
        `Could not determine what is listening on port ${port}: ${(error as Error).message}`,
        { cause: error }
      );
    }
  },
};
