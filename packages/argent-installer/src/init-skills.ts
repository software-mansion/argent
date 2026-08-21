import * as p from "@clack/prompts";
import pc from "picocolors";
import { track } from "@argent/telemetry";
import {
  SKILLS_DIR,
  buildArgentSkillsSource,
  isOnline,
  isSkillsCliAvailable,
  withNpmForce,
  listBundledSkills,
} from "./utils.js";
import { InitCancelled } from "./init-args.js";
import type { Scope } from "./init-scope.js";
import { runNpxSkills } from "./npx-skills.js";

export type SkillsMethod = "default" | "interactive" | "manual";
/** Where the skills were actually installed from. */
export type SkillsSource = "pinned" | "bundled";

export interface SkillsStepResult {
  method: SkillsMethod;
  outcome: "success" | "failure" | "skipped";
  /** Null when nothing was attempted (manual instructions only). */
  source: SkillsSource | null;
  /** True only when the pinned source failed and the bundled copy rescued it. */
  usedFallback: boolean;
}

// Step 2 — install skills via `npx skills`. Emits the skill_install telemetry
// event itself (it owns all the inputs). Throws InitCancelled("skills") on a
// cancelled method prompt.

/** Matches the usual missing-ref wording. Used for telemetry only — never to decide. */
const REF_MISSING =
  /Remote branch .* not found in upstream|couldn't find remote ref|unknown revision/i;

/**
 * The line worth showing out of a wall of subprocess output. The first line is
 * usually an npm warning about `--force`, so prefer the one that names the
 * actual failure and fall back to the first non-noise line.
 */
function meaningfulLine(err: unknown): string {
  const lines = (err instanceof Error ? err.message : String(err))
    .split("\n")
    .map((l) => l.replace(/^[│┌└■◇\s]+/, "").trim())
    .filter(Boolean);
  return (
    lines.find((l) => /^fatal:|^Error:|Failed to|not found|Could not/i.test(l)) ??
    lines.find((l) => !/^npm (WARN|notice)/i.test(l)) ??
    lines[0] ??
    "unknown error"
  );
}

/**
 * Report a skills install that could not be rescued. The manual command names
 * the source that could still work, not the one that just failed — printing the
 * failing command back as the remedy is what made the original report so
 * confusing.
 */
function reportSkillsFailure(
  method: SkillsMethod,
  spinner: { stop: (msg?: string) => void },
  err: unknown,
  attempted: string
): void {
  if (method === "default") spinner.stop(pc.red("Skills installation failed."));
  p.log.error(`Failed to install skills from ${attempted}: ${meaningfulLine(err)}`);
  p.log.info(`You can install them manually:\n  npx skills add ${SKILLS_DIR} --skill '*' -y`);
}

export async function runSkillsStep(args: {
  nonInteractive: boolean;
  fromTar: string | null;
  version: string;
  scope: Scope;
  customRoot?: string;
}): Promise<SkillsStepResult> {
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

  // Prefer the GitHub-pinned source: it keeps skills-lock.json portable by
  // recording a shared ref rather than a path on this machine. The bundled copy
  // is the same version's skills either way (it ships inside this package), so
  // falling back to it below costs provenance, not content.
  const useGitHubSource = online && !fromTar && version !== "unknown";
  const skillsSource = useGitHubSource ? buildArgentSkillsSource(version) : SKILLS_DIR;

  let skillOutcome: "success" | "failure" | "skipped";
  // Which source the skills actually came from, and why the pinned one lost.
  let skillsSourceUsed: SkillsSource = skillsSource === SKILLS_DIR ? "bundled" : "pinned";
  let fallbackReason: "ref_missing" | "unclassified" | null = null;

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
    // Rebuilt per source rather than string-swapped, so a retry keeps the scope
    // flag and the offline `--no-install` prefix it was going to run with.
    const buildSkillsArgs = (source: string): string[] => {
      const args = ["skills", "add", source];
      if (scope === "global") args.push("-g");
      if (skillsMethod === "default") args.push("--skill", "*", "-y");
      return offlineWithCache ? ["--no-install", ...args] : args;
    };

    // `--force` softens the host project's npm engine gate (see withNpmForce /
    // issue #298); the displayed and manual-fallback commands stay clean.
    p.log.info(`Running: ${pc.dim("npx")} ${pc.cyan(buildSkillsArgs(skillsSource).join(" "))}`);

    const spinner = p.spinner();
    if (skillsMethod === "default") {
      spinner.start("Installing skills...");
    }

    const skillsCwd = scope === "custom" ? customRoot : undefined;
    const runWith = (source: string) =>
      runNpxSkills(
        withNpmForce(buildSkillsArgs(source)),
        skillsMethod === "interactive",
        skillsCwd
      );

    try {
      await runWith(skillsSource);
      if (skillsMethod === "default") {
        spinner.stop("Skills installed.");
      }
      skillOutcome = "success";
    } catch (err) {
      // Retry against the copy bundled with this package. The decision is
      // deliberately structural rather than a match on the error text: the
      // interactive path captures no output to match against, and the usual
      // cause — git reporting a missing ref — is a translated string, so a text
      // rule would quietly stop working for anyone not running an English
      // toolchain. Every failure the retry cannot rescue simply fails again,
      // cheaply and locally.
      const bundledUsable = skillsSource !== SKILLS_DIR && listBundledSkills().length > 0;

      if (bundledUsable) {
        // Not a red "failed" yet — that would contradict a retry that is about
        // to succeed, which is the same class of lie this fixes.
        if (skillsMethod === "default") {
          spinner.message("Pinned source unavailable — installing the bundled copy...");
        }
        p.log.warn(
          `Could not install skills from ${skillsSource}: ${meaningfulLine(err)}\n` +
            "Falling back to the copy bundled with this package."
        );
        fallbackReason = REF_MISSING.test(String(err)) ? "ref_missing" : "unclassified";
        try {
          await runWith(SKILLS_DIR);
          if (skillsMethod === "default") {
            spinner.stop("Skills installed from the bundled copy.");
          }
          skillOutcome = "success";
          skillsSourceUsed = "bundled";
          p.note(
            [
              "Skills came from the copy bundled with this package, because the",
              "pinned source could not be resolved.",
              "",
              "skills-lock.json now records a path on this machine rather than a",
              "shared source. A later `argent update` on a tagged release restores",
              "the portable entry.",
            ].join("\n"),
            "Skills installed locally"
          );
        } catch (fallbackErr) {
          reportSkillsFailure(skillsMethod, spinner, fallbackErr, SKILLS_DIR);
          skillOutcome = "failure";
        }
      } else {
        reportSkillsFailure(skillsMethod, spinner, err, skillsSource);
        skillOutcome = "failure";
      }
    }
  }

  const usedFallback = fallbackReason !== null && skillOutcome === "success";

  track("installation:skill_install", {
    method: skillsMethod,
    is_online: online,
    has_offline_cache: offlineWithCache,
    outcome: skillOutcome,
    // A release whose tag was never pushed makes every install fall back. That
    // is invisible once the fallback rescues it, so it has to be measurable.
    source: skillOutcome === "skipped" ? null : skillsSourceUsed,
    used_fallback: usedFallback,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
  });

  return {
    method: skillsMethod,
    outcome: skillOutcome,
    source: skillOutcome === "skipped" ? null : skillsSourceUsed,
    usedFallback,
  };
}

export { runNpxSkills } from "./npx-skills.js";
