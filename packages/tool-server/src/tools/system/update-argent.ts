import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { getUpdateState } from "../../utils/update-checker";

// The CLI entrypoint shipped alongside this tool-server bundle (dist/cli.js next
// to dist/tool-server.cjs). Spawning it directly — rather than a bare `argent`
// on PATH — updates the SAME install that is serving this session and works in
// local (committable) mode, where `argent` is not on PATH at all. Null when it
// can't be located (unbundled dev layout); the caller falls back to `argent`.
function resolveCliEntry(): string | null {
  try {
    const entry = path.join(__dirname, "cli.js");
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

// Which install is serving THIS session — the global PATH install or a project's
// committable local devDependency? Spawning our own cli.js is not enough: the
// `update` command re-resolves its target from the cwd, so without an explicit
// flag a global server running inside a repo that ALSO declares argent locally
// would update the local devDep instead of itself. The tool-server bundle lives
// in the argent package's dist/; if that package root sits inside a project's
// node_modules it is the local install, otherwise it is the global one. We walk
// up from cwd so hoisted-workspace / pnpm layouts (bundle under a parent
// node_modules or a .pnpm store) still classify correctly.
function classifyRunningInstall(): "global" | "local" {
  let runningRoot: string;
  try {
    runningRoot = fs.realpathSync(path.dirname(__dirname)); // dist/ -> package root
  } catch {
    return "global";
  }
  let dir = process.cwd();
  while (true) {
    try {
      const nmReal = fs.realpathSync(path.join(dir, "node_modules"));
      if (runningRoot === nmReal || runningRoot.startsWith(nmReal + path.sep)) {
        return "local";
      }
    } catch {
      // no node_modules at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "global";
}

// Map the resolved target to the `argent update` flags that pin it, so the
// spawned update never re-guesses from cwd.
function targetFlagsFor(target: "global" | "local" | "both"): string[] {
  if (target === "both") return ["--global", "--local"];
  return [`--${target}`];
}

const zodSchema = z.object({
  target: z
    .enum(["auto", "global", "local", "both"])
    .optional()
    .describe(
      "Which install to update. 'auto' (default) updates the install serving this session — " +
        "the global PATH install or this project's local devDependency, whichever this server runs from. " +
        "Pass 'global' / 'local' to force one, or 'both' when the user has both and wants each updated."
    ),
});

let updateScheduled = false;

export const updateArgentTool: ToolDefinition<{
  target?: "auto" | "global" | "local" | "both";
}> = {
  id: "update-argent",
  description:
    "Apply a pending Argent update. Only call this tool when the user has explicitly consented to updating Argent in this conversation. Use when an update notification indicates a new version is available and the user agrees to update. By default updates the install serving this session; pass `target` to choose global/local/both. Returns { message } with the update status and version info. The tool server will restart automatically after the update. Fails if no update is available or an update is already in progress.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params, _options) {
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

    // Resolve the target BEFORE scheduling so the confirmation message names the
    // install we will actually update. 'auto' pins the install serving this
    // session; anything else honors the agent's explicit choice.
    const requested = params?.target ?? "auto";
    const resolved = requested === "auto" ? classifyRunningInstall() : requested;
    const targetFlags = targetFlagsFor(resolved);

    updateScheduled = true;

    // Delay the actual update spawn so the HTTP response can be flushed first.
    // The update process calls killToolServer() which sends SIGTERM — we need
    // the response to reach the MCP server before that happens.
    setTimeout(() => {
      const cliEntry = resolveCliEntry();
      const updateArgs = ["update", "--yes", ...targetFlags, "--version", installableVersion];
      const cmd = cliEntry ? process.execPath : "argent";
      const args = cliEntry ? [cliEntry, ...updateArgs] : updateArgs;
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ARGENT_UPDATE_TRIGGER: "mcp_update" },
      });
      // A detached child with no error listener turns a spawn failure (ENOENT
      // when `argent` isn't on PATH — the norm in local mode) into an
      // unhandled 'error' event that crashes the whole tool-server. Swallow it:
      // the update simply doesn't happen and the next notification re-offers it.
      child.on("error", (err) => {
        console.error(`[update-argent] failed to spawn updater: ${err}`);
        updateScheduled = false;
      });
      child.unref();
    }, 2000);

    const targetLabel =
      resolved === "both" ? "global and project-local installs" : `${resolved} install`;
    // When we auto-updated only one of two possible installs, hint at the flag
    // for the other so the agent can offer it if the user also has that one.
    const otherHint =
      requested === "auto" && resolved !== "both"
        ? ` If you also have a ${resolved === "local" ? "global" : "project-local"} install, ` +
          `call this tool again with target "${resolved === "local" ? "global" : "local"}" to update it too.`
        : "";

    return {
      message:
        `Argent update initiated (v${currentVersion} -> v${installableVersion}) for the ${targetLabel}. ` +
        `The tool server will stop and restart automatically once the update is installed. ` +
        `Subsequent tool calls will reconnect to the updated server.${otherHint}`,
    };
  },
};
