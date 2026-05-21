import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  copyRulesAndAgents,
  type McpConfigAdapter,
} from "./mcp-configs.js";
import {
  RULES_DIR,
  AGENTS_DIR,
  getInstalledVersion,
  getLatestVersion,
  getLocallyInstalledVersion,
  isNewerVersion,
  resolveProjectRoot,
} from "./utils.js";
import { formatShellCommand } from "./package-manager.js";
import { runShellCommand } from "./shell.js";
import { refreshArgentSkills, formatSkillRefreshSummary } from "./skills.js";
import { PACKAGE_NAME } from "./constants.js";
import {
  parseInitArgs,
  validateInitArgs,
  reportInitArgsError,
  InitArgsError,
  type InitArgs,
} from "./init-args.js";
import { promptInstallMode } from "./init-mode-prompt.js";
import { runInstall } from "./install-runner.js";
import {
  GLOBAL,
  LOCAL,
  isGloballyInstalled,
  isLocallyInstalled,
  type Topology,
  type TopologyId,
} from "./topology.js";
import { chooseAdapters } from "./init-adapters.js";
import { chooseScope, type Scope } from "./init-scope.js";
import { writeMcpConfigs } from "./init-mcp-write.js";
import { configureAllowlist } from "./init-allowlist.js";
import { runSkillsStep, type SkillsMethod } from "./init-skills.js";

// `argent init` orchestrator. Each phase below is a thin call into a
// dedicated module — the goal is for this file to read top-to-bottom
// like a recipe, with no inline branching on install topology.

export async function init(rawArgs: string[]): Promise<void> {
  const parsed = parseInitArgs(rawArgs);
  try {
    validateInitArgs(parsed);
  } catch (err) {
    if (err instanceof InitArgsError) {
      reportInitArgsError(err);
      process.exit(1);
    }
    throw err;
  }

  printBanner();
  p.intro(pc.bgCyan(pc.black(" argent init ")));

  let version = getInstalledVersion() ?? "unknown";
  p.log.info(`${pc.dim("Package:")} ${PACKAGE_NAME}@${version}`);

  // ── Step 0 — decide topology + install if needed ─────────────────────
  const projectRoot = resolveProjectRoot(process.cwd());
  const topology = await decideTopology(parsed, projectRoot);
  version = await ensureInstalled({ topology, parsed, projectRoot, version });

  // ── Step 1 — MCP configuration ────────────────────────────────────────
  p.log.step(pc.bold("Step 1: MCP Server Configuration"));
  announceLocalMode(topology.id);

  const { selected: selectedAdapters } = await chooseAdapters({
    topology: topology.id,
    nonInteractive: parsed.nonInteractive,
  });
  p.log.info(`Editors: ${selectedAdapters.map((a) => pc.cyan(a.name)).join(", ")}`);

  const scopeChoice = await chooseScope({
    topology: topology.id,
    nonInteractive: parsed.nonInteractive,
  });
  const effectiveRoot = scopeChoice.scope === "custom" ? scopeChoice.customRoot! : projectRoot;
  const normalizedScope: "local" | "global" =
    scopeChoice.scope === "global" ? "global" : "local";

  const mcpLines = writeMcpConfigs({
    adapters: selectedAdapters,
    topology: topology.id,
    scope: scopeChoice.scope,
    effectiveRoot,
    projectRoot,
  });
  p.note(mcpLines.join("\n"), "MCP Configuration");

  // ── Tool auto-approval ───────────────────────────────────────────────
  const allowlist = await configureAllowlist({
    adapters: selectedAdapters,
    effectiveRoot,
    scope: normalizedScope,
    nonInteractive: parsed.nonInteractive,
  });
  if (allowlist.enabled && allowlist.lines.length > 0) {
    p.note(allowlist.lines.join("\n"), "Tool Auto-Approval");
  }

  // ── Step 2 — Skills ─────────────────────────────────────────────────
  const skillsMethod = await runSkillsStep({
    nonInteractive: parsed.nonInteractive,
    fromTar: parsed.fromTar,
    version,
    scope: scopeChoice.scope,
    customRoot: scopeChoice.customRoot,
  });

  // ── Step 3 — Rules & Agents ──────────────────────────────────────────
  p.log.step(pc.bold("Step 3: Rules & Agents"));
  const copyResults = copyRulesAndAgents(
    selectedAdapters,
    effectiveRoot,
    normalizedScope,
    RULES_DIR,
    AGENTS_DIR
  );
  if (copyResults.length > 0) {
    p.note(copyResults.join("\n"), "Rules & Agents");
  } else {
    p.log.info(pc.dim("No rules or agents to copy for selected editors."));
  }

  // ── Summary ──────────────────────────────────────────────────────────
  printSummary({
    topology: topology.id,
    selectedAdapters,
    scope: scopeChoice.scope,
    allowlistEnabled: allowlist.enabled,
    skillsMethod,
    copiedRules: copyResults.length > 0,
  });

  p.note(
    [
      pc.bold(pc.green("Argent is ready!")),
      "",
      `${pc.bold("Get started")} by asking your assistant:`,
      "",
      `   ${pc.bold(pc.cyan(`"What can Argent do?"`))}`,
      "",
      pc.dim("It will walk you through all capabilities available."),
    ].join("\n"),
    pc.bgGreen(pc.black(" Get Started "))
  );
  p.outro("Done.");
}

// ── Step 0 helpers ──────────────────────────────────────────────────────

// Pick the topology by following the same priority the CLI documents:
//   1. --devdep / --local-install         (parsed.forcedTopology)
//   2. Already globally installed        → stay global
//   3. Non-interactive                   → global default
//   4. Interactive prompt
async function decideTopology(parsed: InitArgs, projectRoot: string): Promise<Topology> {
  if (parsed.forcedTopology === "local") return LOCAL;
  if (isGloballyInstalled()) return GLOBAL;
  if (parsed.nonInteractive) return GLOBAL;

  const choice = await promptInstallMode({
    locallyInstalled: isLocallyInstalled(projectRoot),
  });
  return choice === "local" ? LOCAL : GLOBAL;
}

interface EnsureInstalledArgs {
  topology: Topology;
  parsed: InitArgs;
  projectRoot: string;
  version: string;
}

// Branches by topology, but each branch is short. Local: skip when already
// installed, otherwise run via install-runner. Global: install if missing,
// reinstall if --from, otherwise offer an interactive update.
async function ensureInstalled({
  topology,
  parsed,
  projectRoot,
  version,
}: EnsureInstalledArgs): Promise<string> {
  if (topology === LOCAL) {
    if (isLocallyInstalled(projectRoot)) {
      p.log.info(
        `Argent is already installed as a devDependency at ` +
          `${pc.dim(`${projectRoot}/node_modules/@swmansion/argent`)}. Skipping install step.`
      );
      return getLocallyInstalledVersion(projectRoot) ?? version;
    }
    return runInstall({
      topology,
      projectRoot,
      fromTar: parsed.fromTar,
      fallbackVersion: version,
    });
  }

  // Global topology.
  if (!isGloballyInstalled() || parsed.fromTar) {
    return runInstall({
      topology,
      projectRoot,
      fromTar: parsed.fromTar,
      fallbackVersion: version,
    });
  }
  return await offerInteractiveUpdate({ version, nonInteractive: parsed.nonInteractive, projectRoot });
}

interface OfferUpdateArgs {
  version: string;
  nonInteractive: boolean;
  projectRoot: string;
}

async function offerInteractiveUpdate({
  version,
  nonInteractive,
  projectRoot,
}: OfferUpdateArgs): Promise<string> {
  let latest: string | null = null;
  const spinner = p.spinner();
  spinner.start("Checking for updates...");
  try {
    latest = getLatestVersion();
  } catch {
    // Registry unreachable - silently skip.
  }
  spinner.stop(pc.dim("Version check complete."));

  if (!latest || !isNewerVersion(latest, version)) return version;
  if (nonInteractive) return version;

  const choice = await p.select({
    message: `Update available: ${pc.yellow(`v${version}`)} → ${pc.green(`v${latest}`)}`,
    options: [
      { value: "update" as const, label: `Update to v${latest} (recommended)` },
      { value: "skip" as const, label: "Skip", hint: "Continue with current version" },
    ],
  });
  if (p.isCancel(choice) || choice !== "update") return version;

  const cmd = GLOBAL.installCommand(projectRoot, `${PACKAGE_NAME}@${latest}`);
  const cmdStr = formatShellCommand(cmd);
  const updateSpinner = p.spinner();
  updateSpinner.start(`Updating to v${latest}...`);
  try {
    await runShellCommand(cmd);
    updateSpinner.stop(pc.green(`Updated to v${latest}.`));
    const installedVersion = getInstalledVersion() ?? latest;

    // After a version bump, refresh every scope that already tracks
    // argent skills so orphans (skills removed by the newer argent)
    // surface before Step 2's single-scope add.
    const summary = formatSkillRefreshSummary(refreshArgentSkills(projectRoot));
    if (summary) p.note(summary, "Skills Updated");
    return installedVersion;
  } catch (err) {
    updateSpinner.stop(pc.red("Update failed."));
    p.log.error(`${err}`);
    p.log.info(`You can update manually later: ${pc.cyan(cmdStr)}`);
    return version;
  }
}

// ── Step-1 helpers ─────────────────────────────────────────────────────

function announceLocalMode(topology: TopologyId): void {
  if (topology !== "local") return;
  p.log.info(
    `${pc.dim("Mode:")} Local devDependency — argent is pinned in ${pc.cyan("package.json")}, ` +
      `MCP configs point at ${pc.cyan("./node_modules/.bin/argent")}.\n` +
      `  Commit the changed files (package.json, lockfile, MCP configs) so the team shares this setup.`
  );
}

// ── Summary ────────────────────────────────────────────────────────────

interface SummaryArgs {
  topology: TopologyId;
  selectedAdapters: McpConfigAdapter[];
  scope: Scope;
  allowlistEnabled: boolean;
  skillsMethod: SkillsMethod;
  copiedRules: boolean;
}

function printSummary({
  topology,
  selectedAdapters,
  scope,
  allowlistEnabled,
  skillsMethod,
  copiedRules,
}: SummaryArgs): void {
  const scopeLabel = topology === "local" ? "local devDependency" : scope;
  const lines = [
    `${pc.green("MCP server")} configured for ${selectedAdapters.map((a) => a.name).join(", ")} (${scopeLabel})`,
    `${pc.green("Auto-approve")} ${allowlistEnabled ? "enabled" : "skipped"}`,
    `${pc.green("Skills")} ${skillsMethod === "manual" ? "instructions printed" : "installed"}`,
    `${pc.green("Rules & agents")} ${copiedRules ? "copied" : "n/a"}`,
  ];
  p.note(lines.join("\n"), "Summary");

  if (topology === "local") {
    p.note(
      [
        pc.bold("Commit these so the team shares the setup:"),
        `  • ${pc.cyan("package.json")}  ${pc.dim("(devDependency entry)")}`,
        `  • ${pc.cyan("package-lock.json / pnpm-lock.yaml / yarn.lock / bun.lock")}  ${pc.dim("(pin)")}`,
        `  • the per-editor MCP config files written above`,
        `  • optionally ${pc.cyan(".claude/")}, ${pc.cyan(".cursor/")} etc. for the skills/rules`,
      ].join("\n"),
      "Team Share"
    );
  }
}

// ── Banner ─────────────────────────────────────────────────────────────

export function printBanner(): void {
  const lines = [
    " █████╗ ██████╗  ██████╗ ███████╗███╗   ██╗████████╗",
    "██╔══██╗██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
    "███████║██████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║",
    "██╔══██║██╔══██╗██║   ██║██╔══╝  ██║╚██╗██║   ██║",
    "██║  ██║██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║",
    "╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝",
  ];
  const width = Math.max(...lines.map((l) => l.length));
  console.log();
  for (const line of lines) console.log(line);
  const attribution = "by Software Mansion";
  console.log(" ".repeat(width - attribution.length) + pc.dim(attribution));
  console.log();
}
