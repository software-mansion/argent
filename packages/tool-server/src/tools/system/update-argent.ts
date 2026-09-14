import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { getUpdateState } from "../../utils/update-checker";

// dist/cli.js next to this bundle. Spawning it, rather than a bare `argent` on
// PATH, updates the SAME install serving this session and works in local
// (committable) mode where `argent` isn't on PATH. Null in the unbundled dev
// layout; the caller falls back to `argent`.
function resolveCliEntry(): string | null {
  try {
    const entry = path.join(__dirname, "cli.js");
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

const PACKAGE_NAME = "@swmansion/argent";

// Which install serves THIS session — global PATH install or a project's local
// devDependency — and, for local, WHICH project. `argent update` re-resolves
// its target from ITS cwd, and the detached updater inherits this server's
// editor-chosen cwd (often `/` or `$HOME`), so the target must be pinned
// explicitly. ARGENT_INSTALL_KIND / ARGENT_PROJECT_ROOT win: argent classifies
// them at process start while cwd is still trustworthy (bundled-paths.ts). The
// cwd walk below is only a fallback for servers spawned by older argent
// versions, since that cwd is editor-chosen.
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

// Nearest ancestor of cwd that PROVABLY hosts a local install: a committed
// .argent/install.json or a manifest declaring the dependency. A bare
// package.json is deliberately not enough; with an editor-chosen cwd of
// `$HOME`, a stray home-dir manifest must not become the update target.
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
      // Same declaration shapes as the installer's probe
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

// Pin the target on the spawned `argent update` so it never re-guesses from cwd.
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
  interaction: {
    startedMsg: () => `Updating Argent to ${getUpdateState().installableVersion ?? "latest"}`,
    completedMsg: () => `Updated Argent to ${getUpdateState().installableVersion ?? "latest"}`,
    failedMsg: ({ failureSignal }) => `Failed to update Argent: ${failureSignal.error_code}`,
  },
  description:
    "Apply a pending Argent update. Only call this tool when the user has explicitly consented to updating Argent in this conversation. Use when an update notification indicates a new version is available and the user agrees to update. By default updates the install serving this session; pass `target` to choose global/local/both. Returns { message } with the update status and version info. The tool server will restart automatically after the update. Fails if no update is available or an update is already in progress.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params, _options) {
    const { updateAvailable, updateInstallable, currentVersion, installableVersion } =
      getUpdateState();

    // Resolve the target BEFORE the availability gates: getUpdateState only
    // knows the RUNNING install, so a cross-install (or 'both') target must not
    // be refused on its version — the spawned installer re-checks each target
    // against the registry.
    const requested = params?.target ?? "auto";
    const running = classifyRunningInstall();
    const resolved = requested === "auto" ? running.kind : requested;

    // A local-targeted update needs an explicitly pinned project root, since
    // the spawned updater must not re-derive it from its inherited cwd.
    // Re-validate the recorded root on disk — the project may be gone since
    // this server started — and refuse rather than pin the wrong project.
    let projectRoot: string | null = null;
    let effectiveTarget = resolved;
    if (resolved === "local" || resolved === "both") {
      const recordedRoot =
        running.projectRoot && fs.existsSync(running.projectRoot) ? running.projectRoot : null;
      // The cwd walk is only meaningful for a LOCAL-serving server, whose cwd
      // is its own project. A global-serving server is shared across projects
      // with its cwd frozen at whatever session spawned it FIRST, so walking
      // it could rewrite a different project's manifest.
      projectRoot =
        recordedRoot ?? (running.kind === "local" ? findDeclaringProjectRoot(process.cwd()) : null);
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
    // the running install, and skipping its gates would spawn a pointless
    // updater and falsely promise a restart when everything is current.
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

    // Delay the spawn so this response reaches the MCP server before the
    // updater SIGTERMs this tool-server.
    setTimeout(() => {
      const cliEntry = resolveCliEntry();
      // Pin --version only when the target IS the running install — it came
      // from ITS update state; cross-install targets resolve their own.
      const updateArgs = ["update", "--yes", ...targetFlags];
      if (targetsOnlyRunningInstall && installableVersion) {
        updateArgs.push("--version", installableVersion);
      }
      // Pin WHERE via a flag, not the child's cwd: the installer's
      // resolveProjectRoot walks editor/.git markers and can pick a DIFFERENT
      // ancestor in monorepos — and a vanished cwd would fail the spawn.
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
      // Without an error listener a spawn failure (ENOENT when `argent` isn't
      // on PATH — the norm in local mode) crashes the tool-server. The next
      // update notification re-offers.
      child.on("error", (err) => {
        console.error(`[update-argent] failed to spawn updater: ${err}`);
        updateScheduled = false;
      });
      // Updater exited without killing this server (declined or no-op'd) —
      // unblock future calls; a successful update restarts this server anyway.
      child.on("exit", () => {
        updateScheduled = false;
      });
      child.unref();
    }, 2000);

    const targetLabel =
      effectiveTarget === "both"
        ? "global and project-local installs"
        : `${effectiveTarget} install`;
    // A local-serving server can target the global install through this tool;
    // the reverse needs the CLI, since a shared global server cannot prove
    // WHICH project's local install the caller means.
    const otherHint =
      requested === "auto" && resolved !== "both"
        ? resolved === "local"
          ? ` If you also have a global install, call this tool again with target "global" to update it too.`
          : ` If you also have a project-local install, run \`argent update --local\` in that project to update it too.`
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

    // Only a target covering the RUNNING install restarts this session's
    // server; promising a restart otherwise leaves the agent waiting for a
    // reconnect that never happens.
    const coversRunningInstall = targetsOnlyRunningInstall || effectiveTarget === "both";
    const restartNote = coversRunningInstall
      ? ` The tool server will stop and restart automatically once the update is installed. ` +
        `Subsequent tool calls will reconnect to the updated server.`
      : ` This session's tool server is not affected and keeps running; the update applies only ` +
        `to the targeted install.`;

    return {
      message:
        `Argent update initiated ${versionInfo}for the ${targetLabel}.` +
        crossTargetNote +
        restartNote +
        `${otherHint}${bothDegradedNote}`,
    };
  },
};
