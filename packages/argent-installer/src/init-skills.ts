import * as p from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "node:child_process";
import { track } from "@argent/telemetry";
import { SKILLS_DIR, buildArgentSkillsSource, isOnline, isSkillsCliAvailable } from "./utils.js";
import { resolveSkillsRunner, type SkillsRunner } from "./skills-runner.js";
import { InitCancelled } from "./init-args.js";
import type { Scope } from "./init-scope.js";

export type SkillsMethod = "default" | "interactive" | "manual";

// Step 2. Emits the skill_install telemetry event itself (it owns all the
// inputs). Throws InitCancelled("skills") on a cancelled method prompt.
export async function runSkillsStep(args: {
  nonInteractive: boolean;
  fromTar: string | null;
  version: string;
  scope: Scope;
  customRoot?: string;
}): Promise<SkillsMethod> {
  const { nonInteractive, fromTar, version, scope, customRoot } = args;

  p.log.step(pc.bold("Step 2: Skills Installation"));
  p.log.warn(pc.yellow("Skills installation is required for Argent to function properly."));

  let skillsMethod: SkillsMethod;

  const online = await isOnline();
  const offlineWithCache = !online && isSkillsCliAvailable();
  const skillsCliReady = online || offlineWithCache;
  const runner = resolveSkillsRunner();

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
          hint: `Installs all skills automatically with ${runner.label} skills`,
        },
        {
          value: "interactive" as const,
          label: "Interactive",
          hint: `Full ${runner.label} skills TUI - choose skills, agents, and method`,
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

  let skillOutcome: "success" | "failure" | "skipped";

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
        `  ${pc.dim(`# Or use ${runner.label} skills directly:`)}`,
        `  ${runner.label} skills add ${skillsSource}`,
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

    // `--no-install` is npx-only. isSkillsCliAvailable() probes npx, so
    // offlineWithCache already implies it; the check keeps that explicit.
    const baseArgs =
      offlineWithCache && runner.bin === "npx" ? ["--no-install", ...skillsArgs] : skillsArgs;
    // buildArgs adds whatever the runner needs (npx: --force; pnpm: dlx);
    // baseArgs stays clean for the displayed and manual-fallback commands.
    const runnerArgs = runner.buildArgs(baseArgs);

    p.log.info(`Running: ${pc.dim(runner.label)} ${pc.cyan(baseArgs.join(" "))}`);

    const spinner = p.spinner();
    if (skillsMethod === "default") {
      spinner.start("Installing skills...");
    }

    try {
      const skillsCwd = scope === "custom" ? customRoot : undefined;
      await runSkillsCli(runner, runnerArgs, skillsMethod === "interactive", skillsCwd);
      if (skillsMethod === "default") {
        spinner.stop("Skills installed.");
      }
      skillOutcome = "success";
    } catch (err) {
      if (skillsMethod === "default") {
        spinner.stop(pc.red("Skills installation failed."));
      }
      p.log.error(`Failed to run ${runner.label} skills: ${err}`);
      p.log.info(`You can install skills manually:\n  ${runner.label} ${skillsArgs.join(" ")}`);
      skillOutcome = "failure";
    }
  }

  track("installation:skill_install", {
    method: skillsMethod,
    is_online: online,
    has_offline_cache: offlineWithCache,
    outcome: skillOutcome,
  });

  return skillsMethod;
}

function runSkillsCli(
  runner: SkillsRunner,
  args: string[],
  interactive: boolean,
  cwd?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "win32" ? `${runner.bin}.cmd` : runner.bin;
    const child = spawn(cmd, args, {
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
        reject(new Error(output || `${runner.label} skills exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}
