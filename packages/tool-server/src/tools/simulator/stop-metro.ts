import { z } from "zod";
import { execFileSync } from "node:child_process";
import type { ToolDefinition } from "@argent/registry";

/**
 * Parse the raw output of `netstat -ano` (Windows) into the deduped set of PIDs
 * *listening* on `port`. Pure string parsing, split out of `listeningPids` so
 * the win32 row-matching can be unit-tested without a Windows host.
 *
 * Each row is `proto localAddr foreignAddr state pid`. A row matches when it is
 * a TCP row whose local address ends in `:<port>` and whose FOREIGN address is a
 * wildcard endpoint (`0.0.0.0:0` / `[::]:0` / `*:*`) — the locale-independent
 * signature of a listener. The State column is deliberately NOT used: Windows
 * localizes it (German "ABHÖREN", French "À L'ÉCOUTE"), so keying off the literal
 * "LISTENING" silently matched nothing on a non-English host and stop-metro
 * no-opped while Metro kept running. An ESTABLISHED/other-state connection always
 * has a real remote endpoint in the foreign column, so the wildcard reliably
 * separates the listener (which we kill) from the tool-server's own CDP client
 * socket to Metro (which we must not). The leading colon guards against `:18081`
 * matching port 8081. UDP rows (4 columns, no state) are skipped, and PIDs are
 * deduplicated — a listener bound on both IPv4 `0.0.0.0:<port>` and IPv6
 * `[::]:<port>` reports the same PID on two rows.
 */
export function parseNetstatListeningPids(netstatOutput: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of netstatOutput.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // cols: [proto, localAddr, foreignAddr, state, pid]
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
    // The colon guards against `:18081` matching port 8081.
    if (!cols[1].endsWith(`:${port}`)) continue;
    // Identify a listener by its wildcard foreign endpoint (locale-independent),
    // not the localized State text.
    const foreign = cols[2];
    if (foreign !== "*:*" && !foreign.endsWith(":0")) continue;
    // PID is the trailing column. Read it from the end, not a fixed index — a
    // localized State can span multiple whitespace-split tokens (French
    // "À L'ÉCOUTE"), which would otherwise shift the PID column.
    const pid = parseInt(cols[cols.length - 1], 10);
    if (!Number.isNaN(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * Resolve the PIDs of processes *listening* on a TCP port, cross-platform.
 * Only the listener (Metro itself) is returned, never processes holding an
 * ESTABLISHED connection to the port — otherwise the Argent tool-server's own
 * CDP client socket to Metro would be matched and killed alongside it.
 *
 * - POSIX: `lsof -ti tcp:<port> -sTCP:LISTEN` — one PID per line, exits
 *   non-zero when the port is free.
 * - Windows: `netstat -ano`, then keep TCP rows whose local address ends in
 *   `:<port>` and whose foreign endpoint is a wildcard — the locale-independent
 *   listener signature; the localized State column is deliberately not used (see
 *   parseNetstatListeningPids) — and read the trailing PID column. `lsof`
 *   doesn't exist on Windows, so the prior implementation threw ENOENT there.
 *
 * Both run without a shell, so `port` (already an int by the time it reaches
 * here) can never be interpreted as a shell token.
 */
function listeningPids(port: number): number[] {
  if (process.platform === "win32") {
    const output = execFileSync("netstat", ["-ano"], {
      encoding: "utf-8",
      timeout: 5_000,
      // `netstat -ano` dumps every socket on the host; a busy box easily
      // exceeds Node's default 1 MiB maxBuffer, and the resulting ENOBUFS
      // throw would misread as "port is free" (stopped:false).
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseNetstatListeningPids(output, port);
  }
  const output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
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
  description: `Stop the Metro bundler process listening on a given port (default 8081). Use when ending a React Native session or when Metro must be restarted. Returns { stopped, port, pids }; stopped=false if no process is found on the port. Fails if the port lookup command times out or the process cannot be killed. This is DESTRUCTIVE — always ask the user for confirmation before calling this tool.`,
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
          // On Windows the signal is ignored and the process is terminated
          // outright (Node maps any kill to TerminateProcess); on POSIX
          // SIGTERM lets Metro shut down its watchers cleanly.
          process.kill(pid, "SIGTERM");
        } catch {
          // Process may have already exited
        }
      }

      return { stopped: true, port, pids };
    } catch {
      // lsof / netstat exits non-zero (or finds nothing) when no process is
      // listening on the port.
      return { stopped: false, port, pids: [] };
    }
  },
};
