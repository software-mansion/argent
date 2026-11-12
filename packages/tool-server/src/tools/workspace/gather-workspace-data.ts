import { z } from "zod";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import { readWorkspaceSnapshot, type WorkspaceSnapshot } from "../../utils/workspace-reader";

/**
 * `kind: "directory"` gates on the path existing on this host so a remote
 * caller gets an actionable error instead of the all-nulls snapshot
 * readWorkspaceSnapshot returns for an unreadable path.
 */
const fileInputs: FileInputSpec[] = [
  { target: "workspacePath", path: "${workspacePath}", kind: "directory" },
];

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
  description: `Fetch a structured snapshot of a mobile app project's workspace, for SDK callers.

Returns package.json contents, metro/babel config text, app.json, eas.json, tsconfig,
platform directory presence (ios/, android/), presence of android/gradlew (android_has_gradle),
iOS .xcworkspace name and Podfile presence, lockfile type, .env file keys (no values),
installed CLI tool versions, scripts/ directory listing, husky hooks, CI config type,
Makefile targets, lint-staged config, and a list of detected config files.
Use when a program needs the project type (React Native, Expo, Flutter, native iOS/Android,
or other), build commands, platform support, package manager or QA tooling.
Items it cannot read are null or empty collections. Fails if workspacePath is not a directory on the tool-server host.`,
  zodSchema,
  readOnly: true,
  hideFromMcp: true,
  interaction: {
    startedMsg: () => "Gathering workspace data",
    completedMsg: () => "Gathered workspace data",
    failedMsg: ({ failureSignal }) =>
      `Failed to gather workspace data: ${failureSignal.error_code}`,
  },
  fileInputs,
  services: () => ({}),
  async execute(_services, params) {
    return readWorkspaceSnapshot(params.workspacePath);
  },
};
