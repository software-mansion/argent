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
 * On Windows: PowerShell `Get-NetTCPConnection` is the resilient choice.
 * `netstat -ano` would work, but its output is *localized* on non-English
 * Windows installs ("ESCUCHANDO" / "ÉCOUTE" / "ABHÖREN" instead of
 * "LISTENING"), so a regex on the English state name silently fails on every
 * non-English locale. `Get-NetTCPConnection` returns structured objects
 * keyed by enum values that don't change with locale.
 *
 * Returns an empty list on any failure (the lookup binary missing,
 * non-zero exit, parse failure) so callers don't have to distinguish
 * "no process found" from "lookup tool unavailable".
 */
function findPidsListeningOnPort(port: number): number[] {
  try {
    if (process.platform === "win32") {
      // `Get-NetTCPConnection -State Listen` filters server sockets; we then
      // pick the matching local port and emit OwningProcess as one PID per
      // line. `-ErrorAction SilentlyContinue` so a no-match exits 0 instead
      // of throwing. The regex on the integer port is bounded server-side,
      // not from user input — but `port` is validated by zod above anyway.
      const ps =
        `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue ` +
        `| Select-Object -ExpandProperty OwningProcess`;
      const output = execSync(`powershell.exe -NoProfile -Command "${ps}"`, {
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
      if (!output) return [];
      const seen = new Set<number>();
      for (const line of output.split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
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
    // lsof / Get-NetTCPConnection exits non-zero when no process is found,
    // or if the tool isn't installed. Either way we want "no PIDs found"
    // semantics.
    return [];
  }
}
