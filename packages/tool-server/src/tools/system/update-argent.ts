import { spawn } from "node:child_process";
import type { ToolDefinition } from "@argent/registry";

export const updateArgentTool: ToolDefinition<void> = {
  id: "update-argent",
  description:
    "Applies a pending Argent update. Only call this tool when the user has explicitly consented to updating Argent in this conversation. The tool server will restart automatically after the update.",
  services: () => ({}),
  async execute(_services, _params, _options) {
    // Delay the actual update spawn so the HTTP response can be flushed first.
    // The update process calls killToolServer() which sends SIGTERM — we need
    // the response to reach the MCP server before that happens.
    setTimeout(() => {
      const child = spawn("npx", ["@swmansion/argent", "update", "--yes"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }, 2000);

    return {
      message:
        "Argent update initiated. The tool server will stop and restart automatically once the update is installed. Subsequent tool calls will reconnect to the updated server.",
    };
  },
};
