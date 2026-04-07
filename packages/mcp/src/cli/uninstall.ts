import * as p from "@clack/prompts";
import pc from "picocolors";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { ALL_ADAPTERS, removeCodexRules } from "./mcp-configs.js";
import { detectPackageManager, globalUninstallCommand, formatShellCommand } from "./utils.js";
import { PACKAGE_NAME } from "./constants.js";
import { killToolServer } from "../launcher.js";

export async function uninstall(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  const pruneFlag = args.includes("--prune");

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

  const projectRoot = process.cwd();
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

  let shouldPrune = pruneFlag;

  if (!shouldPrune && !nonInteractive) {
    p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

    const pruneChoice = await p.confirm({
      message: "Also remove skills, rules, and agents directories?",
      initialValue: false,
    });

    if (!p.isCancel(pruneChoice)) {
      shouldPrune = pruneChoice as boolean;
    }
  }

  if (shouldPrune) {
    const pruneResults: string[] = [];

    // Skills: offer to run npx skills remove --all
    let skillsRemoved = false;
    if (!nonInteractive) {
      p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

      const removeSkills = await p.confirm({
        message: "Run `npx skills remove --all` to clean up skills?",
        initialValue: true,
      });

      if (!p.isCancel(removeSkills) && removeSkills) {
        try {
          execSync("npx skills remove --all", { stdio: "inherit" });
          skillsRemoved = true;
          pruneResults.push(`${pc.green("+")} Skills removed via npx skills`);
        } catch {
          pruneResults.push(
            `${pc.yellow("-")} npx skills remove failed — removing directories manually`
          );
        }
      }
    }

    // Remove directories
    const dirsToRemove: [string, string][] = [
      [path.join(projectRoot, ".claude", "skills"), ".claude/skills"],
      [path.join(projectRoot, ".claude", "agents"), ".claude/agents"],
      [path.join(projectRoot, ".claude", "rules"), ".claude/rules"],
      [path.join(projectRoot, ".cursor", "rules"), ".cursor/rules"],
      [path.join(projectRoot, ".cursor", "skills"), ".cursor/skills"],
      [path.join(homedir(), ".claude", "skills"), "~/.claude/skills"],
      [path.join(homedir(), ".claude", "agents"), "~/.claude/agents"],
      [path.join(homedir(), ".claude", "rules"), "~/.claude/rules"],
      [path.join(homedir(), ".cursor", "rules"), "~/.cursor/rules"],
      [path.join(homedir(), ".cursor", "skills"), "~/.cursor/skills"],
    ];

    for (const [dir, label] of dirsToRemove) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true });
          pruneResults.push(`${pc.green("+")} Removed ${label}`);
        }
      } catch (err) {
        pruneResults.push(`${pc.red("x")} Could not remove ${label}: ${err}`);
      }
    }

    // Codex: remove argent rules from developer_instructions in config.toml
    for (const configPath of [
      path.join(projectRoot, ".codex", "config.toml"),
      path.join(homedir(), ".codex", "config.toml"),
    ]) {
      try {
        if (removeCodexRules(configPath)) {
          pruneResults.push(`${pc.green("+")} Removed argent rules from ${configPath}`);
        }
      } catch (err) {
        pruneResults.push(`${pc.red("x")} Could not clean ${configPath}: ${err}`);
      }
    }

    if (pruneResults.length > 0) {
      p.note(pruneResults.join("\n"), "Pruned Directories");
    }
  } else {
    p.log.info(pc.dim("Kept skills, rules, and agents directories. Pass --prune to remove them."));
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
