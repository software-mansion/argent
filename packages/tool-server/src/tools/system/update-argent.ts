import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@argent/registry";
import { getUpdateState } from "../../utils/update-checker";

let updateScheduled = false;

/**
 * Resolve which `argent` binary to spawn for the update.
 *
 * History: this tool used to call `spawn("argent", ...)` unconditionally,
 * which does a PATH lookup. That works for globally-installed argent,
 * but fails silently with ENOENT for users who installed argent as a
 * project devDependency (the team-share flow) — the binary lives at
 * `<projectRoot>/node_modules/.bin/argent` and is not on PATH. Combined
 * with `detached + stdio: "ignore" + unref + no error listener`, the
 * failure left no trace and the same "update available" notification
 * kept reappearing every session.
 *
 * Resolution order:
 *   1. `<cwd>/node_modules/.bin/argent` (or `argent.cmd` on Windows) if
 *      it exists on disk. The MCP server is launched by the editor with
 *      cwd at the project root, so this is the right place to look.
 *   2. Plain `"argent"` PATH lookup. Preserves the historical behavior
 *      for globally-installed users.
 *
 * We do NOT walk up the tree looking for a node_modules — keeping it
 * simple matches what the install side (`argent init --devdep`) commits
 * to .mcp.json (`./node_modules/.bin/argent`, relative to project root).
 */
export function resolveArgentBinary(cwd: string = process.cwd()): {
  binary: string;
  spawnCwd?: string;
} {
  const isWin = process.platform === "win32";
  const localBin = path.join(cwd, "node_modules", ".bin", isWin ? "argent.cmd" : "argent");
  try {
    if (fs.existsSync(localBin)) {
      // Run the child from the project root so `argent update` resolves
      // its own project-relative checks (lockfile detection, dep
      // declaration probe) consistently with what `argent init` did.
      return { binary: localBin, spawnCwd: cwd };
    }
  } catch {
    // fs failure is non-fatal — fall through to PATH lookup.
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

      // The previous version had no error handler. ENOENT (binary not
      // on PATH) emits an 'error' event synchronously; without a
      // listener it was swallowed because the parent never observed it
      // (detached + unref'd + stdio ignored). Surface it to stderr so a
      // future failure leaves a trace in the tool-server log instead
      // of vanishing.
      child.on("error", (err) => {
        process.stderr.write(
          `[argent] failed to spawn '${binary}' for update: ${err.message ?? err}\n`
        );
        // Allow another update attempt later — the failed spawn shouldn't
        // wedge the tool into "already in progress" forever.
        updateScheduled = false;
      });

      child.unref();
    }, 2000);

    return {
      message: `Argent update initiated (v${currentVersion} -> v${latestVersion}). The tool server will stop and restart automatically once the update is installed. Subsequent tool calls will reconnect to the updated server.`,
    };
  },
};
