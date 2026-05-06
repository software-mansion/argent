import { spawn } from "node:child_process";
import type { ToolDefinition } from "@argent/registry";
import { getUpdateState } from "../../utils/update-checker";

let updateScheduled = false;

export const updateArgentTool: ToolDefinition<void> = {
  id: "update-argent",
  description:
    "Apply a pending Argent update. Only call this tool when the user has explicitly consented to updating Argent in this conversation. Use when an update notification indicates a new version is available and the user agrees to update. Returns { message } with the update status and version info. The tool server will restart automatically after the update. Fails if no update is available or an update is already in progress.",
  services: () => ({}),
  async execute(_services, _params, _options) {
    const { updateAvailable, currentVersion, latestVersion } = getUpdateState();

    if (!updateAvailable) {
      return {
        message: `Argent is already up to date (v${currentVersion}). No update needed.`,
      };
    }

    if (updateScheduled) {
      return {
        message:
          "An Argent update is already in progress. Please wait for the tool server to restart.",
      };
    }

    updateScheduled = true;

    // Delay the actual update spawn so the HTTP response can be flushed first.
    // The update process calls killToolServer() which sends SIGTERM — we need
    // the response to reach the MCP server before that happens.
    setTimeout(() => {
      // Windows resolves `argent` (an npm shim) as `argent.cmd`. Node's
      // child_process.spawn doesn't do PATHEXT lookup unless `shell: true`,
      // and bare-named cmd shims also need the shell to be invoked
      // correctly — same workaround as the installer's `runShellCommand`.
      const isWin = process.platform === "win32";
      const child = spawn(isWin ? "argent.cmd" : "argent", ["update", "--yes"], {
        detached: true,
        stdio: "ignore",
        shell: isWin,
      });
      child.unref();
    }, 2000);

    return {
      message: `Argent update initiated (v${currentVersion} -> v${latestVersion}). The tool server will stop and restart automatically once the update is installed. Subsequent tool calls will reconnect to the updated server.`,
    };
  },
};
