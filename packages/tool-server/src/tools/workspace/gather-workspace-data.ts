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
  description: `Run an environment scan and return a structured snapshot of a mobile app project's workspace configuration.
Use when you are a subagent tasked with exploring the project environment to determine the project type (React Native, Expo, Flutter, native iOS/Android), build commands, startup scripts, and tooling. Do not call this if you are the main agent and the task can be delegated to the environment-inspector subagent.

Parameters: workspacePath — absolute path to the project root directory (e.g. /Users/dev/MyApp).
Example: { "workspacePath": "/Users/dev/MyApp" }
Returns a snapshot including package.json scripts, metro/babel config, platform directory presence (ios/, android/), lockfile type, .env keys (no values), installed CLI versions, Makefile targets, and detected CI config. Fails if workspacePath does not exist or is not a directory.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    return readWorkspaceSnapshot(params.workspacePath);
  },
};
