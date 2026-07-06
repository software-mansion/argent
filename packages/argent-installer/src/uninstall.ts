import * as p from "@clack/prompts";
import pc from "picocolors";
import { parse as parseYaml } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { init as telemetryInit, track, forget as telemetryForget } from "@argent/telemetry";
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
  isGloballyInstalled,
  probeLocalInstall,
  resolveInstallMode,
  removeInstallRecord,
  resolveProjectRoot,
  RULES_DIR,
  SKILLS_DIR,
  type InstallMode,
  type ShellCommand,
} from "./utils.js";
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

// Catch-all for any unexpected throw in the prune/cleanup section or a prompt,
// so the buffered cli_uninstall_start still flushes with a terminal event.
const UNINSTALL_UNCLASSIFIED_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UNINSTALL_UNCLASSIFIED_FAILED,
  failure_stage: "installer_uninstall_unclassified",
  failure_area: "installer",
  error_kind: "unknown",
};

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
    // Decide this up front (before any config is touched) so an invalid flag or a
    // cancelled coexistence prompt aborts without mutating anything. Only the
    // package removal below is scoped to the target(s); MCP-config/skill cleanup
    // stays workspace-wide as before.
    const uninstallLocalProbe = probeLocalInstall(projectRoot);
    const globalPresent = isGloballyInstalled();
    const localPresent = installMode === "local" && uninstallLocalProbe.installed;
    const targetFlags = parseTargetFlags(args);
    const targetDecision = decideInstallTargets({
      globalPresent,
      localPresent,
      defaultTarget: installMode,
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

    const results: string[] = [];

    // ── Remove MCP entries ──────────────────────────────────────────────────────

    p.log.step(pc.bold("Removing MCP server entries..."));

    for (const adapter of ALL_ADAPTERS) {
      for (const pathFn of [() => adapter.projectPath(projectRoot), () => adapter.globalPath()]) {
        const configPath = pathFn();
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
      const localTargets = getManagedContentTargets(ALL_ADAPTERS, projectRoot, "local");
      const globalTargets = getManagedContentTargets(ALL_ADAPTERS, projectRoot, "global");

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

      // Remove the committed local-mode marker (.argent/install.json).
      try {
        if (removeInstallRecord(projectRoot)) {
          pruneResults.push(`${pc.green("+")} Removed .argent/install.json`);
        }
      } catch (err) {
        pruneResults.push(`${pc.red("x")} Could not remove .argent/install.json: ${err}`);
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
    // Removal is scoped to the target(s) chosen above. A local-mode uninstall
    // removes the repo-local devDependency and never reaches out to the shared
    // GLOBAL install unless the user explicitly asked (a --global flag or the
    // coexistence prompt). The tool-server teardown is likewise scoped to each
    // install's own dir — a server for the OTHER install may be serving another
    // editor session and must be left alone.

    interface RemovableInstall {
      kind: "local" | "global";
      cmd: ShellCommand;
      cwd?: string;
      prompt: string;
      // Interactive default when auto-selected: a local devDep in the project the
      // user ran uninstall in is likely meant to go; a global install is shared,
      // so default off (preserves the prior global-mode behavior).
      defaultRemove: boolean;
      // Install dir the package manager is about to delete — the scope for the
      // tool-server teardown below. Null when unresolvable (Yarn PnP), which
      // simply skips the kill.
      installDir: string | null;
    }

    const buildRemovable = (kind: InstallMode): RemovableInstall | null => {
      if (kind === "local") {
        // PnP-aware probe: a Yarn PnP project has no node_modules but the local
        // devDependency is still there to remove.
        if (!uninstallLocalProbe.installed) return null;
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
        prompt: `Uninstall the global ${PACKAGE_NAME} package?`,
        defaultRemove: false,
        installDir: getGloballyInstalledPackageRoot(),
      };
    };

    const removables = removeTargets
      .map((t) => buildRemovable(t))
      .filter((r): r is RemovableInstall => r !== null);

    if (removables.length === 0) {
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
        execFileSync(removable.cmd.bin, removable.cmd.args, {
          stdio: "inherit",
          ...(removable.cwd ? { cwd: removable.cwd } : {}),
        });
        p.log.success(`Removed ${removable.kind} package.`);
        hasUninstalledPackage = true;

        // The local install is gone — the committed mode marker must go with it
        // even when the user declined the content-pruning step above, or a
        // stale mode:"local" record would keep `update`/`uninstall` targeting a
        // devDependency that no longer exists.
        if (removable.kind === "local" && removeInstallRecord(projectRoot)) {
          p.log.info(pc.dim("Removed .argent/install.json (local mode marker)."));
        }
      } catch (err) {
        p.log.error(`${removable.kind} uninstall failed: ${err}`);
        await finalizeUninstallTelemetry(
          hasPrunedContent,
          hasUninstalledPackage,
          UNINSTALL_PACKAGE_ACTION_FAILED
        );
        return;
      }
    }

    await finalizeUninstallTelemetry(hasPrunedContent, hasUninstalledPackage);
    if (hasUninstalledPackage) {
      try {
        await telemetryForget({ disableConsent: false });
      } catch {
        /* swallow — uninstall must succeed even if forget fails */
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
