import * as p from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { track } from "@argent/telemetry";
import {
  SKILLS_DIR,
  buildArgentSkillsSource,
  getGloballyInstalledPackageRoot,
  getGloballyInstalledVersion,
  getInstalledVersion,
  isOnline,
  isSkillsCliAvailable,
  listBundledSkills,
  npxChildEnv,
  probeLocalInstall,
  resolveProjectRoot,
  shellQuotePath,
  withNpmForce,
} from "./utils.js";
import { InitCancelled } from "./init-args.js";
import { snapshotArgentSkills, listTrackedLegacySkills, pruneLegacySkillDirs } from "./skills.js";
import type { Scope } from "./init-scope.js";
import { ShellCommandError } from "./shell.js";

type SkillsMethod = "default" | "interactive" | "manual";
/** Where the skills were actually installed from. */
type SkillsSource = "pinned" | "bundled";
type SkillsOutcome = "success" | "failure" | "skipped";

export interface SkillsStepResult {
  method: SkillsMethod;
  outcome: SkillsOutcome;
  /** Null when this run installed nothing. */
  source: SkillsSource | null;
  /** True only when the pinned source failed and the bundled copy rescued it. */
  usedFallback: boolean;
  /** Skills this version ships that are on disk in the step's scope, once it finished. */
  installedCount: number;
  /** Of those, the ones this run wrote. */
  installedThisRun: number;
  /** Offline with no cached skills CLI: the manual path was not the user's choice. */
  forcedManual: boolean;
}

/** Matches the usual missing-ref wording. Used for telemetry only, never to decide. */
const REF_MISSING =
  /Remote branch .* not found in upstream|couldn't find remote ref|unknown revision/i;

/**
 * The line worth showing out of a wall of subprocess output: npm opens with
 * warnings (`--force`, the package it is about to fetch), so skip those and prefer
 * the line that names the actual failure.
 */
function meaningfulLine(err: unknown): string {
  const lines = (err instanceof Error ? err.message : String(err))
    .split("\n")
    .map((l) => l.replace(/^[│┌└■◇\s]+/, "").trim())
    .filter((l) => l && !/^npm (warn|notice)/i.test(l));
  return (
    lines.find((l) => l.startsWith("fatal:")) ??
    lines.find((l) => /Error:|Failed to|not found|Could not/i.test(l)) ??
    lines[0] ??
    "unknown error"
  );
}

// The copy matching `version`, from the install this run configured before the
// running package: the lock records its path, and under `npx` the running package
// sits in the npx cache, which only this machine has and npm may clear.
function bundledCopyFor(version: string): string {
  const local = probeLocalInstall(resolveProjectRoot(process.cwd()));
  if (local.packageDir && local.version === version) return path.join(local.packageDir, "skills");
  const globalRoot = getGloballyInstalledPackageRoot();
  if (globalRoot && getGloballyInstalledVersion() === version) {
    return path.join(globalRoot, "skills");
  }
  return SKILLS_DIR;
}

function printManualInstructions(
  source: string,
  bundledCopy: string,
  scope: Scope,
  root: string,
  npxMissing = false
): void {
  // `~` stays bare so the shell expands it; a real root is quoted as one shell word.
  const dir = (sub: string): string =>
    scope === "global" ? `~/${sub}` : shellQuotePath(`${root}/${sub}`);
  const add = `skills add ${source}${scope === "global" ? " -g" : ""} --skill '*' -y`;
  // `skills add` writes to its cwd, so a project-scope command runs from the root.
  const cd = scope === "global" ? "" : `cd ${shellQuotePath(root)} && `;
  p.note(
    [
      `Skills are bundled at:`,
      `  ${pc.cyan(bundledCopy)}`,
      ``,
      `To install manually, copy them to your editor's skills directory:`,
      ``,
      `  ${pc.dim("# Claude Code")}`,
      `  mkdir -p ${dir(".claude/skills")} && cp -r ${bundledCopy}/* ${dir(".claude/skills/")}`,
      ``,
      `  ${pc.dim("# Cursor")}`,
      `  mkdir -p ${dir(".cursor/skills")} && cp -r ${bundledCopy}/* ${dir(".cursor/skills/")}`,
      ``,
      ...(npxMissing
        ? [`  ${pc.dim("# Or, with pnpm:")}`, `  ${cd}pnpm dlx ${add}`]
        : [`  ${pc.dim("# Or use npx skills directly:")}`, `  ${cd}npx ${add}`]),
    ].join("\n"),
    "Manual Skills Installation"
  );
}

// An install that ran, failed, and left none of this version's skills on disk.
// Offline is not here: the probe resolves the public registry host only, so a
// proxy or mirror user can look offline while npm works, and nothing was tried.
export function skillsAreMissing(skills: SkillsStepResult): boolean {
  return skills.outcome === "failure" && skills.installedCount === 0;
}

// Keyed on what this run wrote and on the count from the disk, not on the chosen
// method: reporting "installed" after a failure is #614. Only a pinned attempt
// that failed first is called out: a bundled source chosen deliberately (offline,
// `--from <tgz>`, unknown version) is an ordinary success.
export function formatSkillsSummaryLine(skills: SkillsStepResult): string {
  const count = skills.installedCount;
  const label = pc.yellow("Skills");
  if (skills.outcome === "failure" || skills.forcedManual) {
    const why = skills.forcedManual ? "offline, see the instructions above" : "see the error above";
    return count > 0
      ? `${label} not updated (${why}), ${count} from an earlier install on disk`
      : `${label} NOT installed (${why})`;
  }
  if (skills.method === "manual") {
    const existing = count > 0 ? `, ${count} from an earlier install on disk` : "";
    return `${pc.green("Skills")} instructions printed${existing}`;
  }
  if (skills.outcome === "skipped") {
    const existing = count > 0 ? `, ${count} from an earlier install on disk` : "";
    return `${label} none installed (none selected)${existing}`;
  }
  const written = skills.installedThisRun;
  if (skills.usedFallback) {
    return `${label} ${written} installed from the bundled copy (the pinned source failed)`;
  }
  return `${pc.green("Skills")} ${written} installed`;
}

// Step 2. Emits the skill_install telemetry event itself (it owns all the
// inputs). Throws InitCancelled("skills") on a cancelled method prompt.
export async function runSkillsStep(args: {
  nonInteractive: boolean;
  fromTar: string | null;
  version: string;
  scope: Scope;
  /** The root every other init step writes to: the custom root, else the resolved project root. */
  effectiveRoot: string;
}): Promise<SkillsStepResult> {
  const { nonInteractive, fromTar, version, scope, effectiveRoot } = args;

  // Project-scope `skills` commands act on their cwd, so pin them to init's
  // root. Without this, `init` run from a project subdirectory installs the
  // skills (and skills-lock.json) into that subdirectory instead (#1467).
  const skillsCwd = scope === "global" ? undefined : effectiveRoot;

  p.log.step(pc.bold("Step 2: Skills Installation"));
  p.log.warn(pc.yellow("Skills installation is required for Argent to function properly."));

  let skillsMethod: SkillsMethod;

  const online = await isOnline();
  const offlineWithCache = !online && isSkillsCliAvailable(skillsCwd);
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
  // recording a shared ref rather than a path on this machine.
  const useGitHubSource = online && !fromTar && version !== "unknown";
  const skillsSource = useGitHubSource ? buildArgentSkillsSource(version) : SKILLS_DIR;
  const bundledCopy = useGitHubSource ? bundledCopyFor(version) : SKILLS_DIR;
  const skillsRoot = scope === "global" ? os.homedir() : effectiveRoot;
  const skillsScope = scope === "global" ? "global" : "project";
  // Only the names this version ships count: retired names and stray dirs say
  // nothing about whether Argent's current skills are there.
  const expected = listBundledSkills(bundledCopy);
  const snapshot = () => snapshotArgentSkills(skillsRoot, skillsScope, expected);
  const writtenSince = (before: Map<string, string>): number =>
    [...snapshot()].filter(([name, stamp]) => before.get(name) !== stamp).length;
  const initial = snapshot();

  let skillOutcome: SkillsOutcome;
  let installedFrom = skillsSource;
  let fallbackReason: "ref_missing" | "unclassified" | null = null;

  if (skillsMethod === "manual") {
    printManualInstructions(skillsSource, bundledCopy, scope, effectiveRoot);
    skillOutcome = "skipped";
  } else {
    const interactive = skillsMethod === "interactive";
    // Rebuilt per source rather than string-swapped, so a retry keeps the scope
    // flag and the offline `--no-install` prefix it was going to run with.
    const buildSkillsArgs = (source: string): string[] => {
      const skillsArgs = ["skills", "add", source];
      if (scope === "global") skillsArgs.push("-g");
      if (!interactive) skillsArgs.push("--skill", "*", "-y");
      return offlineWithCache ? ["--no-install", ...skillsArgs] : skillsArgs;
    };

    // `--force` softens the host project's npm engine gate (see withNpmForce);
    // the displayed and manual-fallback commands stay clean.
    p.log.info(`Running: ${pc.dim("npx")} ${pc.cyan(buildSkillsArgs(skillsSource).join(" "))}`);

    const spinner = p.spinner();
    if (!interactive) spinner.start("Installing skills...");

    // Resolves to the outcome of one attempt: success means this attempt wrote a
    // skill. npx can exit 0 without having run the CLI at all (#1335), and the
    // TUI exits 0 when cancelled, which is the user's call and not a failure.
    const attempt = async (source: string, npmFlags: string[] = []): Promise<SkillsOutcome> => {
      const before = snapshot();
      const npxArgs = withNpmForce([...npmFlags, ...buildSkillsArgs(source)]);
      await runNpxSkills(npxArgs, interactive, skillsCwd);
      if (writtenSince(before) > 0) return "success";
      if (interactive) return "skipped";
      throw new Error("The skills CLI exited cleanly, but it installed no skills.");
    };

    const fail = (err: unknown, attempted: string, npxMissing = false): SkillsOutcome => {
      if (!interactive) spinner.stop(pc.red("Skills installation failed."));
      p.log.error(`Failed to install skills from ${attempted}: ${meaningfulLine(err)}`);
      // Name a source that could still work: printing the failing command back as
      // the remedy is what made #614 so confusing.
      printManualInstructions(bundledCopy, bundledCopy, scope, effectiveRoot, npxMissing);
      return "failure";
    };

    try {
      skillOutcome = await attempt(skillsSource);
      if (!interactive) spinner.stop("Skills installed.");
    } catch (err) {
      // Retry against the copy bundled with the package. Deliberately not a match
      // on the error text: the TUI captures no output and git's wording is
      // translated. Whatever the retry cannot rescue just fails a second time. It
      // stays out only when the same runner cannot run at all, or was killed.
      const npxMissing = (err as NodeJS.ErrnoException).code === "ENOENT";
      const interrupted = err instanceof ShellCommandError && err.signal !== null;
      const canRetry =
        skillsSource !== bundledCopy &&
        !npxMissing &&
        !interrupted &&
        listBundledSkills(bundledCopy).length > 0;

      if (!canRetry) {
        skillOutcome = fail(err, skillsSource, npxMissing);
      } else {
        if (!interactive) spinner.stop(pc.yellow("Pinned skills source failed."));
        p.log.warn(`Could not install skills from ${skillsSource}: ${meaningfulLine(err)}`);
        fallbackReason = REF_MISSING.test(String(err)) ? "ref_missing" : "unclassified";

        // Opening a second TUI unasked would be a surprise after the first one failed.
        const retry = interactive
          ? await p.confirm({ message: "Install from the copy bundled with this package instead?" })
          : true;

        if (retry !== true) {
          skillOutcome = fail(err, skillsSource);
        } else {
          if (!interactive) spinner.start("Installing the copy bundled with this package...");
          try {
            // When the first attempt could not fetch the CLI, a second one with
            // npm's default retries only doubles the wait (70s each, live).
            skillOutcome = await attempt(bundledCopy, ["--fetch-retries=0"]);
            if (!interactive) spinner.stop("Skills installed from the bundled copy.");
            installedFrom = bundledCopy;
          } catch (fallbackErr) {
            skillOutcome = fail(fallbackErr, bundledCopy);
          }
        }
      }
    }

    // `skills add` never removes anything, so skills renamed since the last
    // install would sit next to their new names. Interactive installs may have
    // skipped the new names, so only the install-everything path prunes. The
    // legacy names come from this package's bundled set, so skip the prune when
    // the source was another version's (an older local install), which may still
    // ship them.
    if (
      !interactive &&
      skillOutcome === "success" &&
      (installedFrom === SKILLS_DIR || version === getInstalledVersion())
    ) {
      const tracked = listTrackedLegacySkills(skillsRoot, skillsScope);
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
      for (const name of pruneLegacySkillDirs(skillsRoot, skillsScope)) removed.add(name);
      if (removed.size > 0) {
        p.log.info(pc.dim(`Removed legacy skills: ${[...removed].sort().join(", ")}`));
      }
    }
  }

  const usedFallback = fallbackReason !== null && skillOutcome === "success";
  const source: SkillsSource | null =
    skillOutcome !== "success"
      ? null
      : useGitHubSource && installedFrom === skillsSource
        ? "pinned"
        : "bundled";

  track("installation:skill_install", {
    method: skillsMethod,
    is_online: online,
    has_offline_cache: offlineWithCache,
    outcome: skillOutcome,
    // A release whose tag was never pushed makes every install fall back. That
    // is invisible once the fallback rescues it, so it has to be measurable.
    ...(source ? { source } : {}),
    used_fallback: usedFallback,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
  });

  return {
    method: skillsMethod,
    outcome: skillOutcome,
    source,
    usedFallback,
    installedCount: snapshot().size,
    installedThisRun: writtenSince(initial),
    forcedManual: !skillsCliReady,
  };
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

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const output = [stderr, stdout].filter(Boolean).join("\n").trim();
        reject(
          new ShellCommandError(output || `npx skills exited with code ${code}`, code, signal)
        );
      }
    });

    child.on("error", reject);
  });
}
