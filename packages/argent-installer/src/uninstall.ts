import * as p from "@clack/prompts";
import pc from "picocolors";
import { parse as parseYaml } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import { init as telemetryInit, track, resetLocalTelemetryState } from "@argent/telemetry";
import { FAILURE_CODES, type FailureSignal } from "@argent/registry";
import {
  ALL_ADAPTERS,
  getManagedContentTargets,
  removeCodexRules,
  type ManagedContentTarget,
} from "./mcp-configs.js";
import {
  AGENTS_DIR,
  detectPackageManager,
  detectProjectPackageManager,
  formatShellCommand,
  getGloballyInstalledPackageRoot,
  globalUninstallCommand,
  localUninstallCommand,
  isDeclaredLocally,
  isGloballyInstalled,
  probeLocalInstall,
  probeGlobalPackageRemoval,
  resolveInstallMode,
  removeInstallRecord,
  resolveProjectRoot,
  RULES_DIR,
  SKILLS_DIR,
  type InstallMode,
  type ShellCommand,
} from "./utils.js";
import { execShellCommandSync } from "./shell.js";
import { parseTargetFlags, decideInstallTargets, promptInstallTargets } from "./install-targets.js";
import { PACKAGE_NAME } from "./constants.js";
import { killToolServerForInstallDir } from "@argent/tools-client";
import { finalizeTelemetry } from "./telemetry-finalize.js";

type InstallerFailureSignal = FailureSignal & { failure_area: "installer" };

const UNINSTALL_TOOLSERVER_STOP_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UNINSTALL_TOOLSERVER_STOP_FAILED,
  failure_stage: "installer_uninstall_toolserver_stop",
  failure_area: "installer",
  error_kind: "subprocess",
};

const UNINSTALL_PACKAGE_ACTION_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UNINSTALL_PACKAGE_ACTION_FAILED,
  failure_stage: "installer_uninstall_package_action",
  failure_area: "installer",
  error_kind: "subprocess",
};

// The package could not be removed for an environmental reason and we stopped
// BEFORE touching anything. Distinct from UNINSTALL_PACKAGE_ACTION_FAILED, which
// means a removal actually ran and failed — no subprocess is involved here.
const UNINSTALL_PACKAGE_ROOT_NOT_WRITABLE: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UNINSTALL_PACKAGE_ROOT_NOT_WRITABLE,
  failure_stage: "installer_uninstall_package_not_writable",
  failure_area: "installer",
  error_kind: "validation",
};

// Catch-all for any unexpected throw in the prune/cleanup section or a prompt,
// so the buffered cli_uninstall_start still flushes with a terminal event.
const UNINSTALL_UNCLASSIFIED_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UNINSTALL_UNCLASSIFIED_FAILED,
  failure_stage: "installer_uninstall_unclassified",
  failure_area: "installer",
  error_kind: "unknown",
};

/**
 * How to re-run an uninstall that this user lacks the permission to finish.
 *
 * Deliberately NOT `sudo -E`: Ubuntu 25.10 ships sudo-rs, which does not
 * implement that flag at all — it prints "preserving the entire environment is
 * not supported, `-E` is ignored" and HOME still becomes /root. The
 * `sudo VAR=value cmd` form assigns the variable directly in the command's
 * environment, so it survives `env_reset` on both sudo-rs and classic sudo.
 *
 * HOME has to survive, because the global-scope cleanup resolves ~/.claude,
 * ~/.cursor and friends from it; under a reset HOME it would clean root's home
 * and silently leave the user's own config in place. (Running as root does still
 * create a root-owned ~/.argent for telemetry state, and rewrites any config
 * file that keeps non-argent entries as root — unavoidable when the package
 * itself lives in a root-owned prefix.)
 *
 * Re-running ARGENT rather than the package manager directly matters too: the
 * package removal is only half the job, and removing the package by hand strands
 * every MCP entry, skill and rule pointing at a binary that is gone — with
 * argent no longer around to clean them up.
 */
function elevatedRerunHint(): string {
  return process.platform === "win32"
    ? "Re-run this command from an elevated (Administrator) terminal."
    : `Re-run it with elevated permissions: ${pc.cyan('sudo HOME="$HOME" argent uninstall --global')}`;
}

export interface BundledContentRemoval {
  removedPaths: string[];
  removedRoot: boolean;
}

export interface SkillsLockCleanup {
  removedSkills: string[];
  removedFile: boolean;
}

function removeDirIfEmpty(dirPath: string): boolean {
  try {
    if (!fs.existsSync(dirPath)) return false;
    if (!fs.statSync(dirPath).isDirectory()) return false;
    if (fs.readdirSync(dirPath).length > 0) return false;
    fs.rmdirSync(dirPath);
    return true;
  } catch {
    return false;
  }
}

function collectBundledPaths(sourceDir: string): {
  files: string[];
  directories: string[];
} {
  const files: string[] = [];
  const directories: string[] = [];

  function walk(currentDir: string, relativeDir = ""): void {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        directories.push(relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walk(sourceDir);
  return { files, directories };
}

export function removeBundledContent(sourceDir: string, targetDir: string): BundledContentRemoval {
  if (!fs.existsSync(sourceDir) || !fs.existsSync(targetDir)) {
    return { removedPaths: [], removedRoot: false };
  }

  const { files, directories } = collectBundledPaths(sourceDir);
  const removedPaths: string[] = [];

  for (const relativePath of files) {
    const targetPath = path.join(targetDir, relativePath);
    try {
      if (!fs.existsSync(targetPath)) continue;
      if (fs.lstatSync(targetPath).isDirectory()) continue;
      fs.rmSync(targetPath, { force: true });
      removedPaths.push(relativePath);
    } catch {
      // non-fatal
    }
  }

  directories.sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length || b.length - a.length
  );

  for (const relativePath of directories) {
    const targetPath = path.join(targetDir, relativePath);
    try {
      if (!fs.existsSync(targetPath)) continue;
      if (!fs.statSync(targetPath).isDirectory()) continue;
      if (fs.readdirSync(targetPath).length > 0) continue;
      fs.rmdirSync(targetPath);
    } catch {
      // non-fatal
    }
  }

  let removedRoot = false;
  try {
    if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
      if (fs.readdirSync(targetDir).length === 0) {
        fs.rmdirSync(targetDir);
        removedRoot = true;
      }
    }
  } catch {
    // non-fatal
  }

  if (removedRoot) {
    removeDirIfEmpty(path.dirname(targetDir));
  }

  return { removedPaths, removedRoot };
}

function readBundledSkillName(skillFilePath: string, fallbackName: string): string {
  try {
    const content = fs.readFileSync(skillFilePath, "utf8");
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    if (!frontmatter) return fallbackName;
    // Parse the YAML block instead of a nested `name:` regex + quote-strip,
    // which mishandled quoted values, escapes, and `#` comments.
    const data = parseYaml(frontmatter) as { name?: unknown } | null;
    const name = data?.name;
    return typeof name === "string" && name.trim() ? name.trim() : fallbackName;
  } catch {
    return fallbackName;
  }
}

export function getBundledSkillNames(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) return [];

  const skillNames: string[] = [];

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFilePath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFilePath)) continue;
    skillNames.push(readBundledSkillName(skillFilePath, entry.name));
  }

  return [...new Set(skillNames)].sort();
}

export function removeBundledSkillInstalls(
  skillNames: string[],
  targetDir: string
): BundledContentRemoval {
  if (!fs.existsSync(targetDir)) {
    return { removedPaths: [], removedRoot: false };
  }

  const removedPaths: string[] = [];

  for (const skillName of skillNames) {
    const targetPath = path.join(targetDir, skillName);
    try {
      if (!fs.existsSync(targetPath)) continue;

      const stats = fs.lstatSync(targetPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } else {
        fs.rmSync(targetPath, { force: true });
      }

      removedPaths.push(skillName);
    } catch {
      // non-fatal
    }
  }

  const removedRoot = removeDirIfEmpty(targetDir);
  if (removedRoot) {
    removeDirIfEmpty(path.dirname(targetDir));
  }

  return { removedPaths, removedRoot };
}

export function cleanupSkillsLockFile(lockPath: string, skillNames: string[]): SkillsLockCleanup {
  if (!fs.existsSync(lockPath)) {
    return { removedSkills: [], removedFile: false };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { removedSkills: [], removedFile: false };
  }

  const entries = parsed.skills as Record<string, unknown> | undefined;
  if (!entries) {
    return { removedSkills: [], removedFile: false };
  }

  const removedSkills: string[] = [];
  for (const skillName of skillNames) {
    if (!(skillName in entries)) continue;
    delete entries[skillName];
    removedSkills.push(skillName);
  }

  if (removedSkills.length === 0) {
    return { removedSkills: [], removedFile: false };
  }

  if (Object.keys(entries).length === 0) {
    delete parsed.skills;
  } else {
    parsed.skills = entries;
  }

  const otherKeys = Object.keys(parsed).filter((key) => key !== "version" && key !== "skills");
  const hasSkills = Boolean(
    parsed.skills &&
    typeof parsed.skills === "object" &&
    Object.keys(parsed.skills as Record<string, unknown>).length > 0
  );

  if (!hasSkills && otherKeys.length === 0) {
    fs.rmSync(lockPath, { force: true });
    return { removedSkills, removedFile: true };
  }

  fs.writeFileSync(lockPath, JSON.stringify(parsed, null, 2) + "\n");
  return { removedSkills, removedFile: false };
}

function cleanupBundledSkills(skillNames: string[], targets: ManagedContentTarget[]): string[] {
  const results: string[] = [];

  for (const { targetPath, label } of targets) {
    try {
      const { removedPaths, removedRoot } = removeBundledSkillInstalls(skillNames, targetPath);
      if (removedPaths.length === 0 && !removedRoot) continue;

      const itemsLabel = removedPaths.length === 1 ? "skill entry" : "skill entries";
      const rootLabel = removedRoot ? " and removed the now-empty directory" : "";
      results.push(
        `${pc.green("+")} Removed ${removedPaths.length} Argent ${itemsLabel} from ${label}${rootLabel}`
      );
    } catch (err) {
      results.push(`${pc.red("x")} Could not clean ${label}: ${err}`);
    }
  }

  return results;
}

function cleanupBundledTargets(
  sourceDir: string,
  targets: ManagedContentTarget[],
  contentLabel: string
): string[] {
  const results: string[] = [];

  for (const { targetPath, label } of targets) {
    try {
      const { removedPaths, removedRoot } = removeBundledContent(sourceDir, targetPath);
      if (removedPaths.length === 0 && !removedRoot) continue;

      const itemsLabel =
        removedPaths.length === 1 ? `${contentLabel} file` : `${contentLabel} files`;
      const rootLabel = removedRoot ? " and removed the now-empty directory" : "";
      results.push(
        `${pc.green("+")} Removed ${removedPaths.length} Argent ${itemsLabel} from ${label}${rootLabel}`
      );
    } catch (err) {
      results.push(`${pc.red("x")} Could not clean ${label}: ${err}`);
    }
  }

  return results;
}

export async function uninstall(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");

  telemetryInit("installer");
  track("installation:cli_uninstall_start", {});

  let telemetryFinalized = false;
  // Resolved inside the try once the project root is known; reported on the
  // terminal event so the uninstall funnel is split by install mode.
  let installMode: InstallMode = "global";
  const finalizeUninstallTelemetry = async (
    hasPrunedContent: boolean,
    hasUninstalledPackage: boolean,
    failureSignal?: InstallerFailureSignal
  ): Promise<void> => {
    if (telemetryFinalized) return;
    telemetryFinalized = true;
    await finalizeTelemetry(() => {
      track("installation:cli_uninstall_complete", {
        has_pruned_content: hasPrunedContent,
        has_uninstalled_package: hasUninstalledPackage,
        install_mode: installMode,
        ...(failureSignal ?? {}),
      });
    });
  };

  // Declared before the try so the catch can report what actually completed.
  let shouldPrune = nonInteractive;
  let hasPrunedContent = false;
  let hasUninstalledPackage = false;
  let hasUninstalledGlobalPackage = false;
  // First thing that went wrong, reported once after every target is attempted.
  let firstFailure: InstallerFailureSignal | null = null;

  try {
    p.intro(pc.bgRed(pc.white(" argent uninstall ")));

    if (!nonInteractive) {
      p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

      const proceed = await p.confirm({
        message: "Remove argent configuration from this workspace?",
        initialValue: true,
      });

      if (p.isCancel(proceed) || !proceed) {
        await finalizeUninstallTelemetry(false, false);
        p.cancel("Uninstall cancelled.");
        process.exit(0);
      }
    }

    const projectRoot = resolveProjectRoot(process.cwd());
    installMode = resolveInstallMode(projectRoot);

    // ── Choose which install(s) to remove ───────────────────────────────────────
    // Decided up front so an invalid flag or cancelled coexistence prompt aborts
    // before anything is mutated. Package removal is scoped to the target(s);
    // config/content cleanup follows a narrowed target too (see scopesToClean
    // below) and is otherwise workspace-wide as before.
    const uninstallLocalProbe = probeLocalInstall(projectRoot);
    const globalPresent = isGloballyInstalled();
    const localPresent = installMode === "local" && uninstallLocalProbe.installed;
    const targetFlags = parseTargetFlags(args);
    // Default to the install that is actually PRESENT: a local-mode record whose
    // devDependency isn't materialized (fresh clone) must not shadow a present
    // global install. When both coexist non-interactively, only the local devDep
    // is removed (unlike `update -y`, which acts on both): removal is destructive
    // and the global install is shared with other projects, so nuking it needs
    // an explicit --global.
    const defaultUninstallTarget: InstallMode = localPresent
      ? "local"
      : globalPresent
        ? "global"
        : installMode;
    const targetDecision = decideInstallTargets({
      globalPresent,
      localPresent,
      defaultTarget: defaultUninstallTarget,
      flags: targetFlags,
      nonInteractive,
      nonInteractiveBothDefault: ["local"],
    });

    let removeTargets: InstallMode[] = [];
    // A --global/--local flag or the coexistence multiselect IS the confirmation,
    // so it suppresses the per-install confirm below; a lone auto-selected install
    // still gets the usual prompt (global stays default-off).
    let removePreconfirmed = targetFlags.global || targetFlags.local;
    if (targetDecision.kind === "prompt") {
      const picked = await promptInstallTargets("remove");
      if (picked === "cancel") {
        await finalizeUninstallTelemetry(false, false);
        p.cancel("Uninstall cancelled.");
        process.exit(0);
      }
      removeTargets = picked;
      removePreconfirmed = true;
    } else {
      removeTargets = targetDecision.targets;
    }

    // ── Preflight: can we actually remove the global package? ───────────────────
    // Everything below this point is destructive and irreversible, while the
    // package removal at the very end can fail for a purely environmental reason
    // (a root-owned npm prefix, the usual `sudo npm i -g` install). Running them
    // in that order strips the workspace and then leaves the package installed —
    // issue #622. Ask the environment first, while nothing has been touched.
    //
    // Only when the removal is already consented to: on a bare interactive run
    // the per-install confirm below defaults to NO, and pruning-while-keeping the
    // package is a supported outcome we must not turn into a hard failure.
    const removalPreconsented = nonInteractive || removePreconfirmed;
    let blockedGlobalRemoval = false;
    // Blocked, but the user still gets asked (interactive, unconfirmed) — the
    // prompt says so rather than letting them opt into a removal that will fail.
    let globalRemovalNeedsElevation = false;
    if (removeTargets.includes("global") && globalPresent) {
      const probe = probeGlobalPackageRemoval();
      if (probe.verdict === "blocked") {
        p.log.error(
          `Cannot remove the global ${PACKAGE_NAME} package: ` +
            `${pc.dim(probe.parentDir ?? "the install directory")} is not writable by this user, ` +
            `so the removal would fail partway through.`
        );
        p.log.info(elevatedRerunHint());
        if (removalPreconsented) {
          blockedGlobalRemoval = true;
          firstFailure = UNINSTALL_PACKAGE_ROOT_NOT_WRITABLE;
          // Drop the target rather than aborting outright: a `--global --local`
          // run can still remove the local devDependency. Dropping it also feeds
          // the scope rule below, which then keeps the retained global install's
          // config wired up instead of orphaning it.
          removeTargets = removeTargets.filter((t) => t !== "global");
        } else {
          // Interactive and unconfirmed: warn, but leave today's behavior intact.
          // The prompt still asks, and still defaults to no.
          globalRemovalNeedsElevation = true;
          p.log.info(
            pc.dim("Skipping the global package removal below will leave your setup as it is.")
          );
        }
      }
    }

    if (blockedGlobalRemoval && removeTargets.length === 0) {
      // Nothing left to do, and nothing has been modified yet. Stop here so the
      // workspace configuration survives — it belongs to an install that is
      // still on this machine.
      p.log.info(
        pc.dim(
          "Nothing was changed by this run: argent is still installed, so its configuration " +
            "was left in place."
        )
      );
      await finalizeUninstallTelemetry(false, false, firstFailure ?? undefined);
      p.outro(pc.red(`${PACKAGE_NAME} was not removed.`));
      process.exit(1);
    }

    // Which config scopes the entry/allowlist/content removal may touch: clean
    // everything EXCEPT the scopes that keep a RETAINED install wired up. A kept
    // global install keeps its global-scope entries (and, in global mode, its
    // project-scope entries too — those run the bare `argent` command); a
    // local-mode project keeps its project-scope entries (committed team files)
    // unless the local install itself is being removed. With nothing retained
    // this cleans both scopes — the historical workspace-wide behavior.
    const scopesToClean = new Set<"local" | "global">(["local", "global"]);
    if (globalPresent && !removeTargets.includes("global")) {
      scopesToClean.delete("global");
      if (installMode === "global") scopesToClean.delete("local");
    }
    if (installMode === "local" && !removeTargets.includes("local")) {
      scopesToClean.delete("local");
    }

    const results: string[] = [];

    // ── Remove MCP entries ──────────────────────────────────────────────────────

    p.log.step(pc.bold("Removing MCP server entries..."));

    for (const adapter of ALL_ADAPTERS) {
      const scopedPaths: Array<["local" | "global", string | null]> = [
        ["local", adapter.projectPath(projectRoot)],
        ["global", adapter.globalPath()],
      ];
      for (const [scope, configPath] of scopedPaths) {
        if (!scopesToClean.has(scope)) continue;
        if (!configPath) continue;
        try {
          const removed = adapter.remove(configPath);
          if (removed) {
            results.push(`${pc.green("+")} Removed from ${adapter.name} ${pc.dim(configPath)}`);
          }
        } catch {
          // non-fatal
        }
      }
    }

    // ── Remove allowlists ──────────────────────────────────────────────────────

    for (const adapter of ALL_ADAPTERS) {
      if (!adapter.removeAllowlist) continue;
      for (const s of ["local", "global"] as const) {
        if (!scopesToClean.has(s)) continue;
        try {
          adapter.removeAllowlist(projectRoot, s);
          results.push(`${pc.green("+")} Removed ${adapter.name} allowlist ${pc.dim(`(${s})`)}`);
        } catch {
          // non-fatal
        }
      }
    }

    if (results.length > 0) {
      p.note(results.join("\n"), "MCP Entries Removed");
    } else {
      p.log.info(pc.dim("No MCP entries found to remove."));
    }

    // ── Prune skills / rules / agents ───────────────────────────────────────────

    if (!nonInteractive) {
      p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

      const pruneChoice = await p.confirm({
        message: "Also remove Argent-owned skills, rules, and agents?",
        initialValue: true,
      });

      if (!p.isCancel(pruneChoice)) {
        shouldPrune = pruneChoice as boolean;
      }
    }

    if (shouldPrune) {
      const pruneResults: string[] = [];
      // Content pruning follows the same scoping as the entry removal above: an
      // explicit single-target uninstall leaves the kept install's scope alone.
      const emptyTargets = {
        skillTargets: [],
        ruleTargets: [],
        agentTargets: [],
        codexConfigTargets: [],
        skillsLockTargets: [],
      };
      const localTargets = scopesToClean.has("local")
        ? getManagedContentTargets(ALL_ADAPTERS, projectRoot, "local")
        : emptyTargets;
      const globalTargets = scopesToClean.has("global")
        ? getManagedContentTargets(ALL_ADAPTERS, projectRoot, "global")
        : emptyTargets;

      const bundledSkillNames = getBundledSkillNames(SKILLS_DIR);
      pruneResults.push(
        ...cleanupBundledSkills(bundledSkillNames, [
          ...localTargets.skillTargets,
          ...globalTargets.skillTargets,
        ])
      );

      for (const { targetPath, label } of [
        ...localTargets.skillsLockTargets,
        ...globalTargets.skillsLockTargets,
      ]) {
        try {
          const { removedSkills, removedFile } = cleanupSkillsLockFile(
            targetPath,
            bundledSkillNames
          );
          if (removedSkills.length === 0 && !removedFile) continue;

          const itemsLabel = removedSkills.length === 1 ? "skill" : "skills";
          const fileLabel = removedFile ? " and removed the now-empty lockfile" : "";
          pruneResults.push(
            `${pc.green("+")} Removed ${removedSkills.length} Argent ${itemsLabel} from ${label}${fileLabel}`
          );
        } catch (err) {
          pruneResults.push(`${pc.red("x")} Could not clean ${label}: ${err}`);
        }
      }

      const bundledTargets: Array<{
        sourceDir: string;
        targets: ManagedContentTarget[];
        contentLabel: string;
      }> = [
        {
          sourceDir: AGENTS_DIR,
          targets: [...localTargets.agentTargets, ...globalTargets.agentTargets],
          contentLabel: "agent",
        },
        {
          sourceDir: RULES_DIR,
          targets: [...localTargets.ruleTargets, ...globalTargets.ruleTargets],
          contentLabel: "rule",
        },
      ];

      for (const { sourceDir, targets, contentLabel } of bundledTargets) {
        try {
          pruneResults.push(...cleanupBundledTargets(sourceDir, targets, contentLabel));
        } catch {
          // non-fatal
        }
      }

      // Codex: remove argent rules from developer_instructions in config.toml
      for (const { targetPath, label } of [
        ...localTargets.codexConfigTargets,
        ...globalTargets.codexConfigTargets,
      ]) {
        try {
          if (removeCodexRules(targetPath)) {
            pruneResults.push(`${pc.green("+")} Removed argent rules from ${label}`);
          }
        } catch (err) {
          pruneResults.push(`${pc.red("x")} Could not clean ${label}: ${err}`);
        }
      }

      // Remove the committed local-mode marker (.argent/install.json) — but not
      // on a --global-only uninstall of a local-mode project, where the record
      // must keep steering update/uninstall at the retained devDependency.
      if (scopesToClean.has("local")) {
        try {
          if (removeInstallRecord(projectRoot)) {
            pruneResults.push(`${pc.green("+")} Removed .argent/install.json`);
          }
        } catch (err) {
          pruneResults.push(`${pc.red("x")} Could not remove .argent/install.json: ${err}`);
        }
      }

      if (pruneResults.length > 0) {
        p.note(pruneResults.join("\n"), "Pruned Argent Content");
      } else {
        p.log.info(pc.dim("No Argent-owned skills, rules, or agents found to remove."));
      }
      hasPrunedContent = pruneResults.length > 0;
    } else {
      p.log.info(pc.dim("Kept Argent-owned skills, rules, and agents."));
    }

    // ── Uninstall the package(s) ─────────────────────────────────────────────────
    // Scoped to the target(s) chosen above: a local-mode uninstall never touches
    // the shared GLOBAL install unless explicitly asked (--global flag or the
    // coexistence prompt). Tool-server teardown is likewise scoped to each
    // install's own dir — the OTHER install's server may be serving another
    // editor session and must be left alone.

    interface RemovableInstall {
      kind: "local" | "global";
      cmd: ShellCommand;
      cwd?: string;
      prompt: string;
      // Interactive default when auto-selected: a local devDep in this project is
      // likely meant to go; a shared global install defaults off (prior behavior).
      defaultRemove: boolean;
      // Install dir the package manager is about to delete — the tool-server
      // teardown scope. Null when unresolvable (Yarn PnP), which skips the kill.
      installDir: string | null;
    }

    const buildRemovable = (kind: InstallMode): RemovableInstall | null => {
      if (kind === "local") {
        // PnP-aware probe: a Yarn PnP project has no node_modules but the local
        // devDependency is still there to remove.
        if (!uninstallLocalProbe.installed) return null;
        // Resolvable is not enough: a hoisted transitive dep or workspace symlink
        // with no .argent record and no manifest declaration is not this
        // project's install (install-record.ts's intent rule); removing it would
        // rewrite a manifest/lockfile the user never opted into and prune a copy
        // other packages depend on.
        if (installMode !== "local" && !isDeclaredLocally(projectRoot)) {
          p.log.info(
            pc.dim(
              `${PACKAGE_NAME} is resolvable from this project but not declared in its ` +
                `package.json — skipping the local package removal.`
            )
          );
          return null;
        }
        return {
          kind: "local",
          cmd: localUninstallCommand(detectProjectPackageManager(projectRoot), PACKAGE_NAME),
          cwd: projectRoot,
          prompt: `Remove the local ${PACKAGE_NAME} devDependency from this project?`,
          defaultRemove: true,
          installDir: uninstallLocalProbe.packageDir,
        };
      }
      if (!globalPresent) return null;
      return {
        kind: "global",
        cmd: globalUninstallCommand(detectPackageManager(), PACKAGE_NAME),
        prompt: globalRemovalNeedsElevation
          ? `Uninstall the global ${PACKAGE_NAME} package? (will fail without elevated permissions)`
          : `Uninstall the global ${PACKAGE_NAME} package?`,
        defaultRemove: false,
        installDir: getGloballyInstalledPackageRoot(),
      };
    };

    const removables = removeTargets
      .map((t) => buildRemovable(t))
      .filter((r): r is RemovableInstall => r !== null);

    // Suppressed when the preflight dropped the global target: the install WAS
    // detected, we just cannot remove it, and "no matching install detected"
    // would contradict the reason we already printed.
    if (removables.length === 0 && !blockedGlobalRemoval) {
      // The probe is PATH/node_modules based, so an install under a different
      // toolchain (or the other mode) is intentionally left untouched.
      p.log.info(
        pc.dim(
          `Skipped package removal: no matching ${PACKAGE_NAME} install detected. ` +
            `If it is installed elsewhere, remove it manually.`
        )
      );
    }

    for (const removable of removables) {
      let shouldRemove = nonInteractive || removePreconfirmed;
      if (!nonInteractive && !removePreconfirmed) {
        p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));
        const choice = await p.confirm({
          message: removable.prompt,
          initialValue: removable.defaultRemove,
        });
        shouldRemove = p.isCancel(choice) ? false : (choice as boolean);
      }
      if (!shouldRemove) continue;

      try {
        if (removable.installDir) await killToolServerForInstallDir(removable.installDir);
      } catch (err) {
        p.log.error(`Could not stop the running tool server: ${err}`);
        await finalizeUninstallTelemetry(
          hasPrunedContent,
          hasUninstalledPackage,
          UNINSTALL_TOOLSERVER_STOP_FAILED
        );
        throw err;
      }

      p.log.info(`Running: ${pc.dim(formatShellCommand(removable.cmd))}`);
      try {
        execShellCommandSync(removable.cmd, removable.cwd ? { cwd: removable.cwd } : {});
        p.log.success(`Removed ${removable.kind} package.`);
        hasUninstalledPackage = true;
        if (removable.kind === "global") hasUninstalledGlobalPackage = true;

        // The committed mode marker must go with the install even when content
        // pruning was declined, or a stale mode:"local" record would keep
        // `update`/`uninstall` targeting a devDependency that no longer exists.
        if (removable.kind === "local" && removeInstallRecord(projectRoot)) {
          p.log.info(pc.dim("Removed .argent/install.json (local mode marker)."));
        }
      } catch (err) {
        // The package manager's own output already streamed to the terminal
        // (execShellCommandSync inherits stdio), so `err` here carries only
        // "Command failed: <cmd>" — there is no stderr to classify. Re-running
        // the probe is what tells us whether this was a permission problem, and
        // it needs no output parsing to do it.
        const blockedNow =
          removable.kind === "global" && probeGlobalPackageRemoval().verdict === "blocked";
        p.log.error(
          blockedNow
            ? `Removing the global ${PACKAGE_NAME} package failed: the install directory is ` +
                `not writable by this user.`
            : `${removable.kind} uninstall failed: ${err}`
        );
        if (blockedNow) {
          p.log.info(elevatedRerunHint());
          if (hasPrunedContent) {
            p.log.warn(
              pc.dim(
                "Workspace configuration was already removed, but the package is still installed."
              )
            );
          }
        }
        firstFailure ??= blockedNow
          ? { ...UNINSTALL_PACKAGE_ACTION_FAILED, failure_spawn_code: "EACCES" }
          : UNINSTALL_PACKAGE_ACTION_FAILED;
        // Keep going: a failed global removal must not silently skip a local one
        // the user also asked for, and finalizing here would report
        // has_uninstalled_package=false even if a later target succeeds.
        continue;
      }
    }

    if (firstFailure) {
      await finalizeUninstallTelemetry(hasPrunedContent, hasUninstalledPackage, firstFailure);
      p.outro(pc.red(`${PACKAGE_NAME} was not fully removed — see above.`));
      process.exit(1);
    }

    await finalizeUninstallTelemetry(hasPrunedContent, hasUninstalledPackage);
    // Reset the machine-wide local telemetry state when the GLOBAL package was
    // removed, or when a removal left NO global install behind. NOT on a
    // local-only removal that keeps a global install — clearing state out from
    // under an installation the user kept would be wrong.
    if (hasUninstalledGlobalPackage || (hasUninstalledPackage && !isGloballyInstalled())) {
      try {
        await resetLocalTelemetryState();
      } catch {
        /* swallow — uninstall must succeed even if the reset fails */
      }
    }

    p.outro(pc.green("argent has been removed."));
  } catch (err) {
    // Any unclassified throw in the prune/cleanup section or a prompt still
    // drains the buffered cli_uninstall_start with a terminal cli_uninstall_complete.
    await finalizeUninstallTelemetry(
      hasPrunedContent,
      hasUninstalledPackage,
      UNINSTALL_UNCLASSIFIED_FAILED
    );
    throw err;
  }
}
