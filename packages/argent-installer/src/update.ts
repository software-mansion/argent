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

  // Probe both topologies up front. Reading versions from each install
  // (rather than from the running module's package.json) is critical:
  // when init/update runs via `npx @swmansion/argent`, the running
  // package is always npm's "latest", so reading PACKAGE_ROOT would
  // mask any outdated install. See getGloballyInstalledVersion and
  // getLocallyInstalledVersion for the topology-specific resolvers.
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

  // Decide which topologies need the install command run. A topology
  // "needs install" when it's currently installed AND its on-disk
  // version is older than npm's latest. If a topology isn't installed,
  // we don't proactively introduce it during an update — that would be
  // a surprising scope expansion (a team-share user wouldn't expect
  // `argent update` to suddenly start installing a global copy).
  const needsGlobal = state.globallyInstalled && isNewerVersion(latest, state.globalVersion!);
  const needsLocal = state.locallyInstalled && isNewerVersion(latest, state.localVersion!);

  // First-time install (neither topology present) — fall through to the
  // existing "install globally" behavior, matching the historical CLI
  // contract for users who run `argent update` to bootstrap.
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
  // The refresh runs even when no install command fired so a teammate
  // can `argent update` to repair stale MCP entries / skills after a
  // package.json bump came in over `git pull`.

  spinner.start("Refreshing workspace configuration...");

  const detected = detectAdapters();
  const mcpResults = refreshMcpConfigs(detected, state);
  refreshAllowlists(detected, projectRoot);

  // Rules and agents should ship from the same place the MCP server
  // does. For a local devDep install, that's the project's
  // node_modules/@swmansion/argent/{rules,agents} — using the module-
  // relative paths instead would, under `npx`, leak the npx cache
  // path into the user's project (and copy whichever version npm just
  // resolved as "latest" rather than the version pinned in the user's
  // package.json).
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
// Each topology has its own install command shape and its own cwd
// requirement. Splitting them keeps the success/failure paths clear and
// avoids interleaving spinners.

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
    // Don't process.exit — the other topology (if any) and the config
    // refresh should still run. A partial update is more useful than
    // halting the whole flow.
  }
}

function buildUpdateCommand(
  topology: InstallTopology,
  projectRoot: string,
  latest: string
): ShellCommand {
  const versioned = `${PACKAGE_NAME}@${latest}`;
  if (topology === "global") {
    // Global install doesn't depend on the project's lockfile;
    // detectPackageManager() with no argument keeps the historical
    // user-agent fallback.
    return globalInstallCommand(detectPackageManager(), versioned);
  }
  // Local: detect from the project's lockfile, NOT the user-agent.
  // Under `npx` the agent is always npm regardless of what manages the
  // project — same trap the install/uninstall sides hit.
  return localDevInstallCommand(detectPackageManager(projectRoot), versioned);
}

// ── MCP / allowlist refresh ─────────────────────────────────────────────

function refreshMcpConfigs(adapters: McpConfigAdapter[], state: TopologyState): string[] {
  const results: string[] = [];

  for (const adapter of adapters) {
    // Refresh both project- and global-scoped paths where they exist.
    // Mode is chosen per path: project-scoped configs use local mode
    // iff the project has argent as a devDep (preserves the team-
    // share wiring); global-scoped configs always use global mode.
    // This preserves the install topology each config was authored
    // against instead of clobbering it during what's nominally a
    // bug-fix update.
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
