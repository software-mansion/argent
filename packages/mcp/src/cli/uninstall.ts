import * as p from "@clack/prompts";
import pc from "picocolors";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ALL_ADAPTERS,
  getManagedContentTargets,
  removeCodexRules,
  type ManagedContentTarget,
} from "./mcp-configs.js";
import {
  AGENTS_DIR,
  detectPackageManager,
  formatShellCommand,
  globalUninstallCommand,
  resolveProjectRoot,
  RULES_DIR,
  SKILLS_DIR,
} from "./utils.js";
import { PACKAGE_NAME } from "./constants.js";
import { killToolServer } from "../launcher.js";

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
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const rawName = frontmatterMatch?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    return rawName ? rawName.replace(/^['"]|['"]$/g, "") : fallbackName;
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

  p.intro(pc.bgRed(pc.white(" argent uninstall ")));

  if (!nonInteractive) {
    p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

    const proceed = await p.confirm({
      message: "Remove argent configuration from this workspace?",
      initialValue: true,
    });

    if (p.isCancel(proceed) || !proceed) {
      p.cancel("Uninstall cancelled.");
      process.exit(0);
    }
  }

  const projectRoot = resolveProjectRoot(process.cwd());
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

  let shouldPrune = nonInteractive;

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
        const { removedSkills, removedFile } = cleanupSkillsLockFile(targetPath, bundledSkillNames);
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

    if (pruneResults.length > 0) {
      p.note(pruneResults.join("\n"), "Pruned Argent Content");
    } else {
      p.log.info(pc.dim("No Argent-owned skills, rules, or agents found to remove."));
    }
  } else {
    p.log.info(pc.dim("Kept Argent-owned skills, rules, and agents."));
  }

  // ── Uninstall the global package ────────────────────────────────────────────

  let shouldUninstallPackage = nonInteractive;

  if (!nonInteractive) {
    p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

    const uninstallPkg = await p.confirm({
      message: `Uninstall the global ${PACKAGE_NAME} package?`,
      initialValue: false,
    });

    if (!p.isCancel(uninstallPkg)) {
      shouldUninstallPackage = uninstallPkg as boolean;
    }
  }

  if (shouldUninstallPackage) {
    const pm = detectPackageManager();
    const cmd = globalUninstallCommand(pm, PACKAGE_NAME);
    p.log.info(`Running: ${pc.dim(formatShellCommand(cmd))}`);

    await killToolServer();

    try {
      execFileSync(cmd.bin, cmd.args, { stdio: "inherit" });
      p.log.success("Package uninstalled.");
    } catch (err) {
      p.log.error(`Uninstall failed: ${err}`);
    }
  }

  p.outro(pc.green("argent has been removed."));
}
