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
  description: `Fetch a structured snapshot of a mobile app project's workspace.

Returns package.json contents, metro/babel config text, app.json, eas.json, tsconfig,
platform directory presence (ios/, android/), lockfile type, .env file keys (no values),
installed CLI tool versions, scripts/ directory listing, husky hooks, CI config type,
Makefile targets, lint-staged config, and a list of detected config files.

DO NOT RUN THIS TOOL IF YOU ARE THE MAIN AGENT AND THIS TASK CAN BE DELEGATED TO A SUBAGENT.

If you are a subagent tasked with exploring the project environment, run this as the first step. The snapshot
provides the raw data needed to determine the project type (React Native, Expo,
Flutter, native iOS/Android, or other), build commands, startup scripts, platform
support, package manager, and QA tooling. Follow up with Read/Glob/Grep for deeper
exploration of anything the snapshot surfaces.
Use when you need to inspect project configuration without manually reading multiple files.
Fails if the workspacePath does not exist or is not a valid project directory.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    return readWorkspaceSnapshot(params.workspacePath);
  },
};
