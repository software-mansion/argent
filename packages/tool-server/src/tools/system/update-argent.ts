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
    const { updateAvailable, updateInstallable, currentVersion, installableVersion } =
      getUpdateState();

    if (!updateAvailable) {
      return {
        message: `Argent is already up to date (v${currentVersion}). No update needed.`,
      };
    }

    if (!updateInstallable) {
      return {
        message:
          "A newer Argent version exists, but it is not installable yet under the current minimum-release-age policy. Please try again later.",
      };
    }

    if (!installableVersion) {
      return {
        message:
          "Argent found an installable update, but could not determine its version. Please try again later.",
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
      const child = spawn("argent", ["update", "--yes", "--version", installableVersion], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ARGENT_UPDATE_TRIGGER: "mcp_update" },
      });
      child.unref();
    }, 2000);

    return {
      message: `Argent update initiated (v${currentVersion} -> v${installableVersion}). The tool server will stop and restart automatically once the update is installed. Subsequent tool calls will reconnect to the updated server.`,
    };
  },
};
