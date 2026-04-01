import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { readWorkspaceSnapshot, type WorkspaceSnapshot } from "../../utils/workspace-reader";

const zodSchema = z.object({
  workspacePath: z
    .string()
    .describe("Absolute path to the project root directory to inspect (e.g. /Users/dev/MyApp)"),
});

export const gatherWorkspaceDataTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  WorkspaceSnapshot
> = {
  id: "gather-workspace-data",
  description: `Read a structured snapshot of a mobile app project's workspace. Use when you are a subagent exploring an unknown project environment, e.g. to determine build commands or package manager. Parameters: workspacePath (absolute path to the project root). Returns package.json, metro/babel config, tsconfig, lockfile type, platform dirs (ios/, android/), .env keys, CLI versions, CI config type, Makefile targets, and detected config files. Fails if workspacePath does not exist.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    return readWorkspaceSnapshot(params.workspacePath);
  },
};
