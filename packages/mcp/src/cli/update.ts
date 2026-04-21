import * as p from "@clack/prompts";
import pc from "picocolors";
import { execFileSync } from "node:child_process";
import { detectAdapters, getMcpEntry, copyRulesAndAgents } from "./mcp-configs.js";
import {
  getInstalledVersion,
  getLatestVersion,
  isNewerVersion,
  detectPackageManager,
  globalInstallCommand,
  formatShellCommand,
  resolveProjectRoot,
  RULES_DIR,
  AGENTS_DIR,
} from "./utils.js";
import { refreshArgentSkills, formatSkillRefreshSummary } from "./skills.js";
import { PACKAGE_NAME } from "./constants.js";
import { killToolServer } from "../launcher.js";

export async function update(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");

  p.intro(pc.bgCyan(pc.black(" argent update ")));

  const installed = getInstalledVersion();
  if (!installed) {
    p.log.error("Could not determine installed version.");
    process.exit(1);
  }

  const spinner = p.spinner();
  spinner.start("Checking for updates...");

  let latest: string;
  try {
    latest = getLatestVersion();
  } catch (err) {
    spinner.stop(pc.red("Could not reach registry."));
    p.log.error(`Failed to check registry: ${err}`);
    process.exit(1);
  }

  spinner.stop("Version check complete.");

  p.log.info(`Installed: ${pc.cyan(`v${installed}`)}`);
  p.log.info(`Latest:    ${pc.cyan(`v${latest}`)}`);

  if (isNewerVersion(latest, installed)) {
    p.log.warn(`Update available: ${pc.yellow(`v${installed}`)} -> ${pc.green(`v${latest}`)}`);

    const pm = detectPackageManager();
    const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@${latest}`);
    const cmdStr = formatShellCommand(cmd);

    if (!nonInteractive) {
      p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

      const proceed = await p.confirm({
        message: `Update to v${latest}?`,
        initialValue: true,
      });

      if (p.isCancel(proceed) || !proceed) {
        p.cancel("Update cancelled.");
        process.exit(0);
      }
    }

    p.log.info(`Running: ${pc.dim(cmdStr)}`);

    await killToolServer();

    try {
      execFileSync(cmd.bin, cmd.args, {
        stdio: "inherit",
        env: { ...process.env, ARGENT_SKIP_POSTINSTALL: "1" },
      });
    } catch (err) {
      p.log.error(`Update failed: ${err}`);
      process.exit(1);
    }
  } else {
    p.log.success("Already on the latest version.");
  }

  // Refresh configuration
  spinner.start("Refreshing workspace configuration...");

  const projectRoot = resolveProjectRoot(process.cwd());
  const detected = detectAdapters();
  const mcpEntry = getMcpEntry();
  const results: string[] = [];

  for (const adapter of detected) {
    // Refresh both local and global configs where they exist
    for (const pathFn of [() => adapter.projectPath(projectRoot), () => adapter.globalPath()]) {
      const configPath = pathFn();
      if (!configPath) continue;
      try {
        adapter.write(configPath, mcpEntry);
        results.push(`${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`);
      } catch {
        // Skip paths that don't exist or can't be written
      }
    }
  }

  // Refresh allowlists
  for (const adapter of detected) {
    if (!adapter.addAllowlist) continue;
    for (const s of ["global", "local"] as const) {
      try {
        adapter.addAllowlist(projectRoot, s);
      } catch {
        // non-fatal
      }
    }
  }

  // Refresh rules and agents
  const ruleResults = [
    ...copyRulesAndAgents(detected, projectRoot, "global", RULES_DIR, AGENTS_DIR),
    ...copyRulesAndAgents(detected, projectRoot, "local", RULES_DIR, AGENTS_DIR),
  ];

  spinner.stop("Configuration refreshed.");

  if (results.length > 0) {
    p.note(results.join("\n"), "MCP Configs Updated");
  }

  if (ruleResults.length > 0) {
    p.note(ruleResults.join("\n"), "Rules & Agents Updated");
  }

  const skillSummary = formatSkillRefreshSummary(refreshArgentSkills(projectRoot));
  if (skillSummary) {
    p.note(skillSummary, "Skills Updated");
  }

  p.outro(pc.green("Update complete."));
}
