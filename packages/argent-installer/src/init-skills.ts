import * as p from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "node:child_process";
import * as os from "node:os";
import { track } from "@argent/telemetry";
import {
  SKILLS_DIR,
  buildArgentSkillsSource,
  getInstalledVersion,
  isOnline,
  isSkillsCliAvailable,
  npxChildEnv,
  withNpmForce,
} from "./utils.js";
import { InitCancelled } from "./init-args.js";
import { listTrackedLegacySkills, pruneLegacySkillDirs } from "./skills.js";
import type { Scope } from "./init-scope.js";

export type SkillsMethod = "default" | "interactive" | "manual";
export type SkillOutcome = "success" | "failure" | "skipped";

// The Skills line of the `argent init` summary.
export function skillsSummaryLine(outcome: SkillOutcome): string {
  if (outcome === "failure") {
    return `${pc.yellow("Skills")} NOT installed, see the error above`;
  }
  return `${pc.green("Skills")} ${outcome === "skipped" ? "instructions printed" : "installed"}`;
}

// The headline of the closing `argent init` note. A skills step that installed
// nothing must not read as ready, whether it failed or only printed instructions.
export function readyHeadline(outcome: SkillOutcome): string {
  return outcome === "success"
    ? pc.green("Argent is ready!")
    : pc.yellow("Skills were not installed, so Argent is not ready yet.");
}

// Step 2. Emits the skill_install telemetry event itself (it owns all the
// inputs). Throws InitCancelled("skills") on a cancelled method prompt.
export async function runSkillsStep(args: {
  nonInteractive: boolean;
  fromTar: string | null;
  version: string;
  scope: Scope;
  customRoot?: string;
}): Promise<{ method: SkillsMethod; outcome: SkillOutcome }> {
  const { nonInteractive, fromTar, version, scope, customRoot } = args;

  p.log.step(pc.bold("Step 2: Skills Installation"));
  p.log.warn(pc.yellow("Skills installation is required for Argent to function properly."));

  let skillsMethod: SkillsMethod;

  const online = await isOnline();
  const offlineWithCache = !online && isSkillsCliAvailable();
  const skillsCliReady = online || offlineWithCache;

  if (!skillsCliReady) {
    p.log.warn(
      pc.yellow("You appear to be offline. ") +
        "Automatic skills installation requires a network connection."
    );
  }

  if (!skillsCliReady) {
    skillsMethod = "manual";
  } else if (nonInteractive) {
    skillsMethod = "default";
  } else {
    p.log.message(pc.dim("  Use arrow keys to move, enter to confirm."));

    const choice = await p.select({
      message: "How would you like to install skills?",
      options: [
        {
          value: "default" as const,
          label: "Automatic",
          hint: "Installs all skills automatically with npx skills",
        },
        {
          value: "interactive" as const,
          label: "Interactive",
          hint: "Full npx skills TUI - choose skills, agents, and method",
        },
        {
          value: "manual" as const,
          label: "Manual",
          hint: "Print instructions for manual installation",
        },
      ],
    });

    if (p.isCancel(choice)) throw new InitCancelled("skills");
    skillsMethod = choice as SkillsMethod;
  }

  const useGitHubSource = online && !fromTar && version !== "unknown";
  const skillsSource = useGitHubSource ? buildArgentSkillsSource(version) : SKILLS_DIR;

  let skillOutcome: SkillOutcome;

  if (skillsMethod === "manual") {
    p.note(
      [
        `Skills are bundled at:`,
        `  ${pc.cyan(SKILLS_DIR)}`,
        ``,
        `To install manually, copy them to your editor's skills directory:`,
        ``,
        `  ${pc.dim("# Claude Code")}`,
        `  cp -r ${SKILLS_DIR}/* ${scope === "global" ? "~/.claude/skills/" : `${scope === "custom" ? customRoot! : "."}/.claude/skills/`}`,
        ``,
        `  ${pc.dim("# Cursor")}`,
        `  cp -r ${SKILLS_DIR}/* ${scope === "global" ? "~/.cursor/skills/" : `${scope === "custom" ? customRoot! : "."}/.cursor/skills/`}`,
        ``,
        `  ${pc.dim("# Or use npx skills directly:")}`,
        `  npx skills add ${skillsSource}`,
      ].join("\n"),
      "Manual Skills Installation"
    );
    skillOutcome = "skipped";
  } else {
    const skillsArgs = ["skills", "add", skillsSource];

    if (scope === "global") {
      skillsArgs.push("-g");
    }

    if (skillsMethod === "default") {
      skillsArgs.push("--skill", "*", "-y");
    }

    const baseArgs = offlineWithCache ? ["--no-install", ...skillsArgs] : skillsArgs;
    // `--force` softens the host project's npm engine gate (see withNpmForce);
    // baseArgs stays clean for the displayed and manual-fallback commands.
    const npxArgs = withNpmForce(baseArgs);

    p.log.info(`Running: ${pc.dim("npx")} ${pc.cyan(baseArgs.join(" "))}`);

    const spinner = p.spinner();
    if (skillsMethod === "default") {
      spinner.start("Installing skills...");
    }

    try {
      const skillsCwd = scope === "custom" ? customRoot : undefined;
      await runNpxSkills(npxArgs, skillsMethod === "interactive", skillsCwd);
      if (skillsMethod === "default") {
        spinner.stop("Skills installed.");
      }
      skillOutcome = "success";
      // `skills add` never removes anything, so skills renamed since the last
      // install would sit next to their new names. Interactive installs may
      // have skipped the new names, so only the install-everything path prunes.
      // The legacy names come from this package's bundled set, so skip the
      // prune when the source was another version's tag (an older local
      // install), which may still ship them.
      const sourceIsBundled = skillsSource === SKILLS_DIR || version === getInstalledVersion();
      if (skillsMethod === "default" && sourceIsBundled) {
        const pruneRoot = scope === "global" ? os.homedir() : (skillsCwd ?? process.cwd());
        const pruneScope = scope === "global" ? "global" : "project";
        const tracked = listTrackedLegacySkills(pruneRoot, pruneScope);
        const removed = new Set<string>();
        if (tracked.length > 0) {
          const removeArgs = ["skills", "remove", "-y", ...(scope === "global" ? ["-g"] : [])];
          try {
            await runNpxSkills(
              withNpmForce([
                ...(offlineWithCache ? ["--no-install"] : []),
                ...removeArgs,
                ...tracked,
              ]),
              false,
              skillsCwd
            );
            for (const name of tracked) removed.add(name);
          } catch {
            // non-fatal: the dir prune below still removes the managed dirs
          }
        }
        for (const name of pruneLegacySkillDirs(pruneRoot, pruneScope)) removed.add(name);
        if (removed.size > 0) {
          p.log.info(pc.dim(`Removed legacy skills: ${[...removed].sort().join(", ")}`));
        }
      }
    } catch (err) {
      if (skillsMethod === "default") {
        spinner.stop(pc.red("Skills installation failed."));
      }
      p.log.error(`Failed to run npx skills: ${err}`);
      p.log.info(`You can install skills manually:\n  npx ${skillsArgs.join(" ")}`);
      skillOutcome = "failure";
    }
  }

  track("installation:skill_install", {
    method: skillsMethod,
    is_online: online,
    has_offline_cache: offlineWithCache,
    outcome: skillOutcome,
  });

  return { method: skillsMethod, outcome: skillOutcome };
}

function runNpxSkills(args: string[], interactive: boolean, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(npxCmd, args, {
      env: npxChildEnv(),
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      ...(cwd ? { cwd } : {}),
    });

    let stdout = "";
    let stderr = "";

    if (!interactive) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const output = [stderr, stdout].filter(Boolean).join("\n").trim();
        reject(new Error(output || `npx skills exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}
