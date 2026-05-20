import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@argent/registry";
import { getUpdateState } from "../../utils/update-checker";

let updateScheduled = false;

// Prefer <cwd>/node_modules/.bin/argent (devDep install — not on PATH);
// fall back to PATH for the historical global install. Don't walk up
// the tree — matches what `argent init --devdep` commits.
export function resolveArgentBinary(cwd: string = process.cwd()): {
  binary: string;
  spawnCwd?: string;
} {
  const isWin = process.platform === "win32";
  const localBin = path.join(cwd, "node_modules", ".bin", isWin ? "argent.cmd" : "argent");
  try {
    if (fs.existsSync(localBin)) {
      // Spawn with cwd = project root so `argent update`'s own
      // lockfile / dep-declaration probes match what `argent init` saw.
      return { binary: localBin, spawnCwd: cwd };
    }
  } catch {
    // fall through to PATH lookup
  }
  return { binary: "argent" };
}

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

    const { binary, spawnCwd } = resolveArgentBinary();

    // Delay the actual update spawn so the HTTP response can be flushed first.
    // The update process calls killToolServer() which sends SIGTERM — we need
    // the response to reach the MCP server before that happens.
    setTimeout(() => {
      const child = spawn(binary, ["update", "--yes"], {
        detached: true,
        stdio: "ignore",
        ...(spawnCwd ? { cwd: spawnCwd } : {}),
      });

      // ENOENT and friends emit 'error' synchronously; with detached +
      // unref'd + stdio ignored and no listener they used to vanish.
      // Log to stderr and clear the in-progress flag so retries work.
      child.on("error", (err) => {
        process.stderr.write(
          `[argent] failed to spawn '${binary}' for update: ${err.message ?? err}\n`
        );
        updateScheduled = false;
      });

      child.unref();
    }, 2000);

    return {
      message: `Argent update initiated (v${currentVersion} -> v${latestVersion}). The tool server will stop and restart automatically once the update is installed. Subsequent tool calls will reconnect to the updated server.`,
    };
  },
};
