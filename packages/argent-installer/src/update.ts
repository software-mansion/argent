import * as p from "@clack/prompts";
import pc from "picocolors";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  detectAdapters,
  getMcpEntry,
  copyRulesAndAgents,
  type McpConfigAdapter,
  type McpEntryMode,
} from "./mcp-configs.js";
import {
  detectPackageManager,
  formatShellCommand,
  getGloballyInstalledVersion,
  getLatestVersion,
  getLocallyInstalledVersion,
  globalInstallCommand,
  isGloballyInstalled,
  isLocallyInstalled,
  isNewerVersion,
  localDevInstallCommand,
  resolveProjectRoot,
  AGENTS_DIR,
  RULES_DIR,
  type ShellCommand,
} from "./utils.js";
import { refreshArgentSkills, formatSkillRefreshSummary } from "./skills.js";
import { PACKAGE_NAME } from "./constants.js";
import { killToolServer } from "@argent/tools-client";

type InstallTopology = "global" | "local";

interface TopologyState {
  globallyInstalled: boolean;
  locallyInstalled: boolean;
  globalVersion: string | null;
  localVersion: string | null;
  projectRoot: string;
}

export async function update(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");

  p.intro(pc.bgCyan(pc.black(" argent update ")));

  // Read versions from each install on disk, not from the running module.
  // Under `npx`, PACKAGE_ROOT is always "latest" and would mask an
  // outdated install.
  const projectRoot = resolveProjectRoot(process.cwd());
  const state: TopologyState = {
    globallyInstalled: isGloballyInstalled(),
    locallyInstalled: isLocallyInstalled(projectRoot),
    globalVersion: null,
    localVersion: null,
    projectRoot,
  };
  if (state.globallyInstalled) state.globalVersion = getGloballyInstalledVersion();
  if (state.locallyInstalled) state.localVersion = getLocallyInstalledVersion(projectRoot);

  if (state.globallyInstalled && !state.globalVersion) {
    p.log.error("Could not determine globally-installed version.");
    process.exit(1);
  }
  if (state.locallyInstalled && !state.localVersion) {
    p.log.error("Could not determine locally-installed devDependency version.");
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

  reportInstalledStatus(state);
  p.log.info(`Latest:    ${pc.cyan(`v${latest}`)}`);

  // Only update topologies already present — never proactively introduce
  // one during an update (would surprise team-share users).
  const needsGlobal = state.globallyInstalled && isNewerVersion(latest, state.globalVersion!);
  const needsLocal = state.locallyInstalled && isNewerVersion(latest, state.localVersion!);

  // Neither installed → preserve the historical bootstrap behavior
  // (`argent update` from scratch installs globally).
  if (!state.globallyInstalled && !state.locallyInstalled) {
    await runFirstTimeGlobalInstall(latest, nonInteractive);
  } else if (!needsGlobal && !needsLocal) {
    p.log.success("Already on the latest version.");
  } else {
    if (needsGlobal) {
      await runTopologyUpdate("global", state, latest, nonInteractive);
    }
    if (needsLocal) {
      await runTopologyUpdate("local", state, latest, nonInteractive);
    }
  }

  // ── Refresh configuration ─────────────────────────────────────────────
  // Runs even when no install fired, so a teammate can repair stale MCP
  // entries / skills after a `git pull` bumped package.json.

  spinner.start("Refreshing workspace configuration...");

  const detected = detectAdapters();
  const mcpResults = refreshMcpConfigs(detected, state);
  refreshAllowlists(detected, projectRoot);

  // Ship rules/agents from the same install the MCP server runs from.
  // In local mode that's node_modules/@swmansion/argent; module-relative
  // paths would, under `npx`, leak the npx cache's "latest" into the
  // project instead of the version pinned in package.json.
  const localArgentRoot = state.locallyInstalled
    ? join(projectRoot, "node_modules", "@swmansion", "argent")
    : null;
  const effectiveRulesDir = localArgentRoot ? join(localArgentRoot, "rules") : RULES_DIR;
  const effectiveAgentsDir = localArgentRoot ? join(localArgentRoot, "agents") : AGENTS_DIR;

  const ruleResults = [
    ...copyRulesAndAgents(detected, projectRoot, "global", effectiveRulesDir, effectiveAgentsDir),
    ...copyRulesAndAgents(detected, projectRoot, "local", effectiveRulesDir, effectiveAgentsDir),
  ];

  spinner.stop("Configuration refreshed.");

  if (mcpResults.length > 0) {
    p.note(mcpResults.join("\n"), "MCP Configs Updated");
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

// ── Reporting helpers ────────────────────────────────────────────────────

function reportInstalledStatus(state: TopologyState): void {
  if (!state.globallyInstalled && !state.locallyInstalled) {
    p.log.warn(`${PACKAGE_NAME} is not installed.`);
    return;
  }
  if (state.globallyInstalled) {
    p.log.info(`Installed (global): ${pc.cyan(`v${state.globalVersion}`)}`);
  }
  if (state.locallyInstalled) {
    p.log.info(
      `Installed (local devDep): ${pc.cyan(`v${state.localVersion}`)} ` +
        `${pc.dim(`(${state.projectRoot})`)}`
    );
  }
}

// ── Install/update flows ────────────────────────────────────────────────

async function runFirstTimeGlobalInstall(latest: string, nonInteractive: boolean): Promise<void> {
  const pm = detectPackageManager();
  const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@${latest}`);
  const cmdStr = formatShellCommand(cmd);

  if (!nonInteractive) {
    p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));
    const proceed = await p.confirm({
      message: `Install ${PACKAGE_NAME}@${latest} globally?`,
      initialValue: true,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel("Install cancelled.");
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
    p.log.error(`Install failed: ${err}`);
    process.exit(1);
  }
}

async function runTopologyUpdate(
  topology: InstallTopology,
  state: TopologyState,
  latest: string,
  nonInteractive: boolean
): Promise<void> {
  const fromVersion = topology === "global" ? state.globalVersion! : state.localVersion!;
  const cmd = buildUpdateCommand(topology, state.projectRoot, latest);
  const cmdStr = formatShellCommand(cmd);
  const label = topology === "global" ? "global package" : "local devDependency (package.json)";

  p.log.warn(
    `Update available (${label}): ${pc.yellow(`v${fromVersion}`)} -> ${pc.green(`v${latest}`)}`
  );

  if (!nonInteractive) {
    p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));
    const proceed = await p.confirm({
      message: `Update the ${label} to v${latest}?`,
      initialValue: true,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.log.info(pc.dim(`Skipped ${label} update.`));
      return;
    }
  }

  p.log.info(
    `Running: ${pc.dim(cmdStr)}` +
      (topology === "local" ? ` ${pc.dim(`(in ${state.projectRoot})`)}` : "")
  );

  await killToolServer();

  try {
    execFileSync(cmd.bin, cmd.args, {
      stdio: "inherit",
      env: { ...process.env, ARGENT_SKIP_POSTINSTALL: "1" },
      ...(topology === "local" ? { cwd: state.projectRoot } : {}),
    });
    p.log.success(`${label} updated to v${latest}.`);
  } catch (err) {
    p.log.error(`${label} update failed: ${err}`);
    // Don't process.exit — let the other topology and the config refresh
    // still run; a partial update beats halting the whole flow.
  }
}

function buildUpdateCommand(
  topology: InstallTopology,
  projectRoot: string,
  latest: string
): ShellCommand {
  const versioned = `${PACKAGE_NAME}@${latest}`;
  if (topology === "global") {
    // No lockfile dependency — no-arg keeps the user-agent fallback.
    return globalInstallCommand(detectPackageManager(), versioned);
  }
  // Local: must use the lockfile — `npx` always reports npm in the agent.
  return localDevInstallCommand(detectPackageManager(projectRoot), versioned);
}

// ── MCP / allowlist refresh ─────────────────────────────────────────────

function refreshMcpConfigs(adapters: McpConfigAdapter[], state: TopologyState): string[] {
  const results: string[] = [];

  for (const adapter of adapters) {
    // Project-scoped configs use local mode iff the project has argent
    // as a devDep (keeps team-share wiring); global-scoped configs are
    // always global mode.
    const targets: Array<{ configPath: string; entryMode: McpEntryMode }> = [];
    const projectPath = adapter.projectPath(state.projectRoot);
    const globalPath = adapter.globalPath();
    if (projectPath) {
      const entryMode: McpEntryMode = state.locallyInstalled
        ? { kind: "local", projectRoot: state.projectRoot }
        : { kind: "global" };
      targets.push({ configPath: projectPath, entryMode });
    }
    if (globalPath) {
      targets.push({ configPath: globalPath, entryMode: { kind: "global" } });
    }

    for (const { configPath, entryMode } of targets) {
      try {
        const entry = getMcpEntry(entryMode, adapter);
        adapter.write(configPath, entry);
        results.push(`${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`);
      } catch {
        // Skip paths that don't exist or can't be written
      }
    }
  }

  return results;
}

function refreshAllowlists(adapters: McpConfigAdapter[], projectRoot: string): void {
  for (const adapter of adapters) {
    if (!adapter.addAllowlist) continue;
    for (const s of ["global", "local"] as const) {
      try {
        adapter.addAllowlist(projectRoot, s);
      } catch {
        // non-fatal
      }
    }
  }
}
