import * as p from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "node:child_process";
import {
  buildArgentSkillsSource,
  isOnline,
  isSkillsCliAvailable,
  SKILLS_DIR,
} from "./utils.js";
import type { Scope } from "./init-scope.js";

export type SkillsMethod = "default" | "interactive" | "manual";

interface SkillsArgs {
  nonInteractive: boolean;
  fromTar: string | null;
  version: string;
  scope: Scope;
  customRoot: string | undefined;
}

export async function runSkillsStep(args: SkillsArgs): Promise<SkillsMethod> {
  p.log.step(pc.bold("Step 2: Skills Installation"));
  p.log.warn(pc.yellow("Skills installation is required for Argent to function properly."));

  const online = await isOnline();
  const offlineWithCache = !online && isSkillsCliAvailable();
  const skillsCliReady = online || offlineWithCache;

  if (!skillsCliReady) {
    p.log.warn(
      pc.yellow("You appear to be offline. ") +
        "Automatic skills installation requires a network connection."
    );
  }

  const method = await chooseMethod(args.nonInteractive, skillsCliReady);

  const useGitHubSource = online && !args.fromTar && args.version !== "unknown";
  const skillsSource = useGitHubSource ? buildArgentSkillsSource(args.version) : SKILLS_DIR;

  if (method === "manual") {
    printManualInstructions(args.scope, args.customRoot, skillsSource);
    return method;
  }

  await runNpxFlow(method, args.scope, args.customRoot, skillsSource, offlineWithCache);
  return method;
}

async function chooseMethod(nonInteractive: boolean, skillsCliReady: boolean): Promise<SkillsMethod> {
  if (!skillsCliReady) return "manual";
  if (nonInteractive) return "default";

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

  if (p.isCancel(choice)) {
    p.cancel("Initialization cancelled.");
    process.exit(0);
  }
  return choice as SkillsMethod;
}

function printManualInstructions(scope: Scope, customRoot: string | undefined, skillsSource: string): void {
  const projectPrefix = customRoot ?? ".";
  const claudeTarget = scope === "global" ? "~/.claude/skills/" : `${projectPrefix}/.claude/skills/`;
  const cursorTarget = scope === "global" ? "~/.cursor/skills/" : `${projectPrefix}/.cursor/skills/`;
  p.note(
    [
      `Skills are bundled at:`,
      `  ${pc.cyan(SKILLS_DIR)}`,
      ``,
      `To install manually, copy them to your editor's skills directory:`,
      ``,
      `  ${pc.dim("# Claude Code")}`,
      `  cp -r ${SKILLS_DIR}/* ${claudeTarget}`,
      ``,
      `  ${pc.dim("# Cursor")}`,
      `  cp -r ${SKILLS_DIR}/* ${cursorTarget}`,
      ``,
      `  ${pc.dim("# Or use npx skills directly:")}`,
      `  npx skills add ${skillsSource}`,
    ].join("\n"),
    "Manual Skills Installation"
  );
}

async function runNpxFlow(
  method: Exclude<SkillsMethod, "manual">,
  scope: Scope,
  customRoot: string | undefined,
  skillsSource: string,
  offlineWithCache: boolean
): Promise<void> {
  const skillsArgs = ["skills", "add", skillsSource];
  if (scope === "global") skillsArgs.push("-g");
  if (method === "default") skillsArgs.push("--skill", "*", "-y");
  const npxArgs = offlineWithCache ? ["--no-install", ...skillsArgs] : skillsArgs;

  p.log.info(`Running: ${pc.dim("npx")} ${pc.cyan(npxArgs.join(" "))}`);

  const spinner = p.spinner();
  if (method === "default") spinner.start("Installing skills...");

  try {
    await runNpxSkills(npxArgs, method === "interactive", scope === "custom" ? customRoot : undefined);
    if (method === "default") spinner.stop("Skills installed.");
  } catch (err) {
    if (method === "default") spinner.stop(pc.red("Skills installation failed."));
    p.log.error(`Failed to run npx skills: ${err}`);
    p.log.info(`You can install skills manually:\n  npx ${skillsArgs.join(" ")}`);
  }
}

function runNpxSkills(args: string[], interactive: boolean, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(npxCmd, args, {
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
