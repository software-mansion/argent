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

const PACKAGE_NAME = "@swmansion/argent";

// Which install is serving THIS session — the global PATH install or a project's
// committable local devDependency, and (for local) WHICH project? Spawning our
// own cli.js is not enough: the `update` command re-resolves its target project
// from ITS cwd, so without an explicit flag — and, for a local target, an
// explicit cwd — a global server running inside a repo that ALSO declares
// argent locally would update the local devDep instead of itself, and a
// detached updater inheriting this server's editor-chosen cwd (often `/` or
// `$HOME`) would bind to the wrong directory entirely.
//
// The authoritative signals are ARGENT_INSTALL_KIND / ARGENT_PROJECT_ROOT,
// classified by the spawning package at process start — the moment cwd is
// trustworthy (a committed local MCP command only resolves with cwd at the
// project root) — and forwarded by the launcher. Fallback for servers spawned
// by older argent versions: the tool-server bundle lives in the argent
// package's dist/; if that package root sits inside a project's node_modules
// it is the local install of THAT project, otherwise the global one. We walk
// up from cwd so hoisted-workspace / pnpm layouts (bundle under a parent
// node_modules or a .pnpm store) still classify correctly — though this
// server's own cwd is editor-chosen, which is exactly why the env signals take
// precedence.
function classifyRunningInstall(): { kind: "global" | "local"; projectRoot: string | null } {
  const envKind = process.env.ARGENT_INSTALL_KIND;
  const envRoot = process.env.ARGENT_PROJECT_ROOT;
  if (envKind === "local" || envKind === "global") {
    return { kind: envKind, projectRoot: envKind === "local" && envRoot ? envRoot : null };
  }
  let runningRoot: string;
  try {
    runningRoot = fs.realpathSync(path.dirname(__dirname)); // dist/ -> package root
  } catch {
    return { kind: "global", projectRoot: null };
  }
  let dir = process.cwd();
  while (true) {
    try {
      const nmReal = fs.realpathSync(path.join(dir, "node_modules"));
      if (runningRoot === nmReal || runningRoot.startsWith(nmReal + path.sep)) {
        return { kind: "local", projectRoot: dir };
      }
    } catch {
      // no node_modules at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { kind: "global", projectRoot: null };
}

// Last-resort project root for a local-targeted update when the running
// install carries none (a global server asked to update the project's local
// install): the nearest ancestor of cwd that PROVABLY hosts a local argent
// install — a committed .argent/install.json or a package.json declaring the
// dependency. A bare package.json is deliberately not enough; with an
// editor-chosen cwd of `$HOME`, a stray home-dir manifest must not become the
// update target.
function findDeclaringProjectRoot(startDir: string): string | null {
  let dir: string;
  try {
    dir = fs.realpathSync(startDir);
  } catch {
    return null;
  }
  while (true) {
    if (fs.existsSync(path.join(dir, ".argent", "install.json"))) return dir;
    try {
      // Same declaration shapes the installer's own probe accepts
      // (topology.ts readManifestDeclaration).
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      if (
        manifest.devDependencies?.[PACKAGE_NAME] ||
        manifest.dependencies?.[PACKAGE_NAME] ||
        manifest.optionalDependencies?.[PACKAGE_NAME]
      ) {
        return dir;
      }
    } catch {
      // no/unreadable manifest at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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

    // Resolve the target BEFORE the availability gates so a target covering an
    // install OTHER than the running one is never refused on the running
    // install's version. getUpdateState only knows the RUNNING install: "we are
    // current" says nothing about the other install being current, so for a
    // cross-install (or 'both') target the spawned installer — which re-checks
    // each target against the registry — gets the final word.
    const requested = params?.target ?? "auto";
    const running = classifyRunningInstall();
    const resolved = requested === "auto" ? running.kind : requested;

    // A local-targeted update needs a project to bind to: the spawned updater
    // must not re-derive the project itself — its inherited cwd is this
    // detached server's editor-chosen (often `/` or `$HOME`) cwd. Pin the
    // proven root explicitly. The recorded root is re-validated on disk (the
    // project may have been deleted/renamed since this server started); when
    // no root can be proven, refuse the local part instead of "initiating" an
    // update that would no-op or bind to the wrong project.
    let projectRoot: string | null = null;
    let effectiveTarget = resolved;
    if (resolved === "local" || resolved === "both") {
      const recordedRoot =
        running.projectRoot && fs.existsSync(running.projectRoot) ? running.projectRoot : null;
      projectRoot = recordedRoot ?? findDeclaringProjectRoot(process.cwd());
      if (!projectRoot) {
        if (resolved === "local") {
          return {
            message:
              "Could not determine which project's local install to update: this tool server " +
              "does not run from a project-local install and no project declaring " +
              `${PACKAGE_NAME} was found around its working directory. ` +
              "Run `argent update --local` in the project directory instead.",
          };
        }
        effectiveTarget = "global";
      }
    }

    // Gates come AFTER the 'both' → 'global' degradation: a degraded target IS
    // the running install, and skipping the gates for it would spawn a
    // pointless updater plus a false "will restart" promise when everything is
    // already current.
    const targetsOnlyRunningInstall = effectiveTarget === running.kind;

    if (targetsOnlyRunningInstall) {
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
    }

    if (updateScheduled) {
      return {
        message:
          "An Argent update is already in progress. Please wait for the tool server to restart.",
      };
    }

    const targetFlags = targetFlagsFor(effectiveTarget);

    updateScheduled = true;

    // Delay the actual update spawn so the HTTP response can be flushed first.
    // The update process calls killToolServer() which sends SIGTERM — we need
    // the response to reach the MCP server before that happens.
    setTimeout(() => {
      const cliEntry = resolveCliEntry();
      // Pin --version only when the target IS the running install — the pinned
      // version came from ITS update state. For a cross-install target the
      // installer resolves the right version per target itself.
      const updateArgs = ["update", "--yes", ...targetFlags];
      if (targetsOnlyRunningInstall && installableVersion) {
        updateArgs.push("--version", installableVersion);
      }
      // Pin WHERE via an explicit flag, not the child's cwd: the installer's
      // own root derivation (resolveProjectRoot) walks editor/.git markers and
      // can resolve a DIFFERENT ancestor than the manifest-proven root in
      // monorepos — and a cwd that vanished since this server started would
      // fail the spawn outright.
      const spawnRoot =
        projectRoot ??
        (running.projectRoot && fs.existsSync(running.projectRoot) ? running.projectRoot : null);
      if (spawnRoot) updateArgs.push("--project-root", spawnRoot);
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
      // The updater exited without killing this server — it declined or
      // no-op'd (target already current, nothing to update). Unblock future
      // calls; a successful update restarts this server anyway.
      child.on("exit", () => {
        updateScheduled = false;
      });
      child.unref();
    }, 2000);

    const targetLabel =
      effectiveTarget === "both"
        ? "global and project-local installs"
        : `${effectiveTarget} install`;
    // When we auto-updated only one of two possible installs, hint at the flag
    // for the other so the agent can offer it if the user also has that one.
    const otherHint =
      requested === "auto" && resolved !== "both"
        ? ` If you also have a ${resolved === "local" ? "global" : "project-local"} install, ` +
          `call this tool again with target "${resolved === "local" ? "global" : "local"}" to update it too.`
        : "";
    const bothDegradedNote =
      resolved === "both" && effectiveTarget === "global"
        ? ` The project-local install was skipped: no project declaring ${PACKAGE_NAME} could be ` +
          "located from this server — run `argent update --local` in the project directory for it."
        : "";
    const versionInfo = targetsOnlyRunningInstall
      ? `(v${currentVersion} -> v${installableVersion}) `
      : "";
    const crossTargetNote = targetsOnlyRunningInstall
      ? ""
      : " The installer checks each targeted install against the registry and no-ops if it is already current.";

    return {
      message:
        `Argent update initiated ${versionInfo}for the ${targetLabel}.` +
        crossTargetNote +
        ` The tool server will stop and restart automatically once the update is installed. ` +
        `Subsequent tool calls will reconnect to the updated server.${otherHint}${bothDegradedNote}`,
    };
  },
};
