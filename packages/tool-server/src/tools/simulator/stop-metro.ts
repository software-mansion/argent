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
  description: `Stop (kill) the Metro bundler process listening on a given port.
Use when you need to free the Metro port, restart the bundler from scratch, or clean up after a session ends. This is DESTRUCTIVE — always ask the user for confirmation before calling.

Parameters: port — TCP port Metro is listening on (default 8081, e.g. 8081 or 8088).
Example: { "port": 8081 }
Returns { stopped: boolean, port, pids: [...] } with the process IDs that were killed. If no process is found on that port, returns stopped: false. Fails if the port is out of range (1–65535).`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const port = (params as { port: number }).port;
    try {
      const output = execSync(`lsof -ti tcp:${port}`, {
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();

      if (!output) {
        return { stopped: false, port, pids: [] };
      }

      const pids = output
        .split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

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
    } catch {
      // lsof exits non-zero when no process is found on the port
      return { stopped: false, port, pids: [] };
    }
  },
};
