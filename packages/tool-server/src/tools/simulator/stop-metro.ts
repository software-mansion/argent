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
  description:
    "Kill the Metro bundler process listening on a given port (default 8081). " +
    "This is DESTRUCTIVE — it kills whatever process holds that port. " +
    "Always ask the user for confirmation before calling this tool, by following message:" +
    "'Would you like to stop the Metro bundler process listening on port ${port}?" +
    "This action is desctructive, before continuing please confirm this is the action you want to take.'" +
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
