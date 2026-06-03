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
import { formatShellCommand } from "./package-manager.js";
import {
  getLatestVersion,
  isNewerVersion,
  resolveProjectRoot,
  RULES_DIR,
  AGENTS_DIR,
} from "./utils.js";
import { GLOBAL, LOCAL, TOPOLOGIES, type Topology, type TopologyState } from "./topology.js";
import { refreshArgentSkills, formatSkillRefreshSummary } from "./skills.js";
import { PACKAGE_NAME } from "./constants.js";
import { killToolServer } from "@argent/tools-client";

// `argent update` orchestrator.
//
// Argent can be installed under two independent topologies (global on
// PATH and/or local devDep). update() probes each, asks whether to bump
// it to npm's latest, and then refreshes MCP entries / skills regardless
// of whether an install fired — that's the path a teammate uses to
// repair stale config after a `git pull` bumped package.json.

interface ProbedTopology {
  topology: Topology;
  state: TopologyState;
}

export async function update(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  p.intro(pc.bgCyan(pc.black(" argent update ")));

  const projectRoot = resolveProjectRoot(process.cwd());
  const probed = probeTopologies(projectRoot);
  if (!assertVersionsResolved(probed)) process.exit(1);

  const latest = await fetchLatestOrExit();

  reportInstalledStatus(probed, projectRoot);
  p.log.info(`Latest:    ${pc.cyan(`v${latest}`)}`);

  await applyUpdates(probed, latest, projectRoot, nonInteractive);
  await refreshConfiguration(probed, projectRoot);

  p.outro(pc.green("Update complete."));
}

// ── Topology probing ────────────────────────────────────────────────────

function probeTopologies(projectRoot: string): ProbedTopology[] {
  return TOPOLOGIES.map((topology) => ({ topology, state: topology.probe(projectRoot) }));
}

function assertVersionsResolved(probed: ProbedTopology[]): boolean {
  for (const { topology, state } of probed) {
    if (state.installed && !state.version) {
      p.log.error(`Could not determine ${topology.label} version.`);
      return false;
    }
  }
  return true;
}

async function fetchLatestOrExit(): Promise<string> {
  const spinner = p.spinner();
  spinner.start("Checking for updates...");
  try {
    const latest = getLatestVersion();
    spinner.stop("Version check complete.");
    return latest;
  } catch (err) {
    spinner.stop(pc.red("Could not reach registry."));
    p.log.error(`Failed to check registry: ${err}`);
    process.exit(1);
  }
}

function reportInstalledStatus(probed: ProbedTopology[], projectRoot: string): void {
  if (!probed.some((t) => t.state.installed)) {
    p.log.warn(`${PACKAGE_NAME} is not installed.`);
    return;
  }
  for (const { topology, state } of probed) {
    if (!state.installed) continue;
    const suffix = topology === LOCAL ? ` ${pc.dim(`(${projectRoot})`)}` : "";
    p.log.info(`Installed (${topology.label}): ${pc.cyan(`v${state.version}`)}${suffix}`);
  }
}

// ── Update application ──────────────────────────────────────────────────

async function applyUpdates(
  probed: ProbedTopology[],
  latest: string,
  projectRoot: string,
  nonInteractive: boolean
): Promise<void> {
  // Neither topology installed → preserve historical bootstrap behavior
  // (install globally).
  if (!probed.some((t) => t.state.installed)) {
    await runFirstTimeGlobalInstall(latest, nonInteractive);
    return;
  }

  const needsUpdate = probed.filter(
    ({ state }) => state.installed && state.version && isNewerVersion(latest, state.version)
  );
  if (needsUpdate.length === 0) {
    p.log.success("Already on the latest version.");
    return;
  }

  for (const { topology, state } of needsUpdate) {
    await runTopologyUpdate(topology, state.version!, latest, projectRoot, nonInteractive);
  }
}

async function runFirstTimeGlobalInstall(latest: string, nonInteractive: boolean): Promise<void> {
  const cmd = GLOBAL.installCommand("", `${PACKAGE_NAME}@${latest}`);
  const cmdStr = formatShellCommand(cmd);

  if (!nonInteractive && !(await confirmYesNo(`Install ${PACKAGE_NAME}@${latest} globally?`))) {
    p.cancel("Install cancelled.");
    process.exit(0);
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
  topology: Topology,
  fromVersion: string,
  latest: string,
  projectRoot: string,
  nonInteractive: boolean
): Promise<void> {
  const cmd = topology.installCommand(projectRoot, `${PACKAGE_NAME}@${latest}`);
  const cwd = topology.spawnCwd(projectRoot);
  const cmdStr = formatShellCommand(cmd);
  const label = topology === LOCAL ? "local devDependency (package.json)" : "global package";

  p.log.warn(
    `Update available (${label}): ${pc.yellow(`v${fromVersion}`)} -> ${pc.green(`v${latest}`)}`
  );

  if (!nonInteractive && !(await confirmYesNo(`Update the ${label} to v${latest}?`))) {
    p.log.info(pc.dim(`Skipped ${label} update.`));
    return;
  }

  p.log.info(`Running: ${pc.dim(cmdStr)}${cwd ? ` ${pc.dim(`(in ${cwd})`)}` : ""}`);
  await killToolServer();
  try {
    execFileSync(cmd.bin, cmd.args, {
      stdio: "inherit",
      env: { ...process.env, ARGENT_SKIP_POSTINSTALL: "1" },
      ...(cwd ? { cwd } : {}),
    });
    p.log.success(`${label} updated to v${latest}.`);
  } catch (err) {
    // Don't process.exit — let the other topology and the config refresh
    // still run; a partial update beats halting the whole flow.
    p.log.error(`${label} update failed: ${err}`);
  }
}

async function confirmYesNo(message: string): Promise<boolean> {
  p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));
  const choice = await p.confirm({ message, initialValue: true });
  if (p.isCancel(choice)) return false;
  return choice as boolean;
}

// ── Config refresh ──────────────────────────────────────────────────────

async function refreshConfiguration(
  probed: ProbedTopology[],
  projectRoot: string
): Promise<void> {
  const spinner = p.spinner();
  spinner.start("Refreshing workspace configuration...");

  const locallyInstalled = probed.find((t) => t.topology === LOCAL)?.state.installed ?? false;
  const detected = detectAdapters();
  const mcpResults = refreshMcpConfigs(detected, projectRoot, locallyInstalled);
  refreshAllowlists(detected, projectRoot);
  const ruleResults = refreshRulesAndAgents(detected, projectRoot, locallyInstalled);

  spinner.stop("Configuration refreshed.");

  if (mcpResults.length > 0) p.note(mcpResults.join("\n"), "MCP Configs Updated");
  if (ruleResults.length > 0) p.note(ruleResults.join("\n"), "Rules & Agents Updated");

  const skillSummary = formatSkillRefreshSummary(refreshArgentSkills(projectRoot));
  if (skillSummary) p.note(skillSummary, "Skills Updated");
}

function refreshMcpConfigs(
  adapters: McpConfigAdapter[],
  projectRoot: string,
  locallyInstalled: boolean
): string[] {
  const results: string[] = [];
  for (const adapter of adapters) {
    // Project-scoped configs follow the project's current topology (keeps
    // team-share wiring intact); global-scoped configs always use global.
    for (const { configPath, mode } of configRefreshTargets(adapter, projectRoot, locallyInstalled)) {
      try {
        adapter.write(configPath, getMcpEntry(mode, adapter));
        results.push(`${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`);
      } catch {
        // skip paths that don't exist or can't be written
      }
    }
  }
  return results;
}

function configRefreshTargets(
  adapter: McpConfigAdapter,
  projectRoot: string,
  locallyInstalled: boolean
): Array<{ configPath: string; mode: McpEntryMode }> {
  const out: Array<{ configPath: string; mode: McpEntryMode }> = [];
  const projectPath = adapter.projectPath(projectRoot);
  const globalPath = adapter.globalPath();
  if (projectPath) {
    out.push({
      configPath: projectPath,
      mode: locallyInstalled ? { kind: "local", projectRoot } : { kind: "global" },
    });
  }
  if (globalPath) {
    out.push({ configPath: globalPath, mode: { kind: "global" } });
  }
  return out;
}

function refreshAllowlists(adapters: McpConfigAdapter[], projectRoot: string): void {
  for (const adapter of adapters) {
    if (!adapter.addAllowlist) continue;
    for (const scope of ["global", "local"] as const) {
      try {
        adapter.addAllowlist(projectRoot, scope);
      } catch {
        // non-fatal
      }
    }
  }
}

// Ship rules/agents from the same install the MCP server runs from.
// In local mode that's node_modules/@swmansion/argent; module-relative
// paths would, under `npx`, leak the npx cache's "latest" into the
// project instead of the version pinned in package.json.
function refreshRulesAndAgents(
  adapters: McpConfigAdapter[],
  projectRoot: string,
  locallyInstalled: boolean
): string[] {
  const localRoot = locallyInstalled
    ? join(projectRoot, "node_modules", "@swmansion", "argent")
    : null;
  const rulesDir = localRoot ? join(localRoot, "rules") : RULES_DIR;
  const agentsDir = localRoot ? join(localRoot, "agents") : AGENTS_DIR;

  return [
    ...copyRulesAndAgents(adapters, projectRoot, "global", rulesDir, agentsDir),
    ...copyRulesAndAgents(adapters, projectRoot, "local", rulesDir, agentsDir),
  ];
}
