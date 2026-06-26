import { z } from "zod";
import { execFileSync } from "node:child_process";
import type { ToolDefinition } from "@argent/registry";

/**
 * Resolve the PIDs of processes *listening* on a TCP port, cross-platform.
 * Only the listener (Metro itself) is returned, never processes holding an
 * ESTABLISHED connection to the port — otherwise the Argent tool-server's own
 * CDP client socket to Metro would be matched and killed alongside it.
 *
 * - POSIX: `lsof -ti tcp:<port> -sTCP:LISTEN` — one PID per line, exits
 *   non-zero when the port is free.
 * - Windows: `netstat -ano`, then filter TCP rows in the LISTENING state whose
 *   local address ends in `:<port>` and read the trailing PID column. `lsof`
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
    });
    const pids = new Set<number>();
    for (const line of output.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // cols: [proto, localAddr, foreignAddr, state, pid]
      if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
      if (cols[3].toUpperCase() !== "LISTENING") continue;
      // The colon guards against `:18081` matching port 8081.
      if (!cols[1].endsWith(`:${port}`)) continue;
      const pid = parseInt(cols[4], 10);
      if (!Number.isNaN(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
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
