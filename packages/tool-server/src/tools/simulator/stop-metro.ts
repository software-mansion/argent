import { z } from "zod";
import { execSync } from "node:child_process";
import type { ToolDefinition } from "@argent/registry";

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
    const pids = findPidsListeningOnPort(port);

    if (pids.length === 0) {
      return { stopped: false, port, pids: [] };
    }

    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process may have already exited
      }
    }

    return { stopped: true, port, pids };
  },
};

/**
 * Cross-platform port → PID resolver.
 *
 * On macOS/Linux: `lsof -ti tcp:<port>` is the canonical way to ask "what
 * process is listening on this TCP port" — `-t` returns just the PIDs, `-i`
 * filters to network sockets.
 *
 * On Windows: `netstat -ano` is the analogue. We grep its output for a
 * "LISTENING" line whose local-address column ends in `:<port>` — every
 * netstat row has the PID in the trailing column. (`-n` suppresses DNS
 * lookups, `-a` includes listening sockets, `-o` adds the PID column.)
 *
 * Returns an empty list on any failure (the lookup binary missing,
 * non-zero exit, parse failure) so callers don't have to distinguish
 * "no process found" from "lookup tool unavailable".
 */
function findPidsListeningOnPort(port: number): number[] {
  try {
    if (process.platform === "win32") {
      const output = execSync("netstat -ano -p TCP", {
        encoding: "utf-8",
        timeout: 5_000,
      });
      // Match a TCP row in the LISTENING state whose local address ends in
      // `:<port>`. `\s+` separates columns; `(\d+)` at end-of-line is the
      // PID. Address format is either `0.0.0.0:8081` (IPv4) or `[::]:8081`
      // (IPv6) — both end in `:<port>`.
      const re = new RegExp(String.raw`^\s*TCP\s+\S+:${port}\s+\S+\s+LISTENING\s+(\d+)\s*$`, "gm");
      const seen = new Set<number>();
      for (const m of output.matchAll(re)) {
        const pid = parseInt(m[1]!, 10);
        if (!Number.isNaN(pid)) seen.add(pid);
      }
      return [...seen];
    }
    const output = execSync(`lsof -ti tcp:${port}`, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    if (!output) return [];
    return output
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
  } catch {
    // lsof / netstat exits non-zero when no process is found, or if the tool
    // isn't installed. Either way we want "no PIDs found" semantics.
    return [];
  }
}
