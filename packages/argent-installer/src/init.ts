import * as p from "@clack/prompts";
import pc from "picocolors";
import { init as telemetryInit, track } from "@argent/telemetry";
import { copyRulesAndAgents, type McpConfigAdapter } from "./mcp-configs.js";
import {
  RULES_DIR,
  AGENTS_DIR,
  getInstalledVersion,
  detectPackageManager,
  resolveProjectRoot,
  resolveInstallModeFromFlags,
  InstallModeFlagError,
  writeInstallRecord,
  removeInstallRecord,
  type InstallMode,
} from "./utils.js";
import { PACKAGE_NAME } from "./constants.js";
import { resolveTelemetryConsent } from "./first-run-notice.js";
import { parseInitArgs, InitCancelled } from "./init-args.js";
import {
  InitTelemetry,
  INSTALL_LOCAL_PRECONDITION_FAILED,
  INSTALL_UNCLASSIFIED_FAILED,
} from "./init-telemetry.js";
import { promptInstallMode } from "./init-mode-prompt.js";
import { runInstall } from "./install-runner.js";
import { chooseAdapters } from "./init-adapters.js";
import { chooseScope, type Scope } from "./init-scope.js";
import { writeMcpConfigs } from "./init-mcp-write.js";
import { configureAllowlist } from "./init-allowlist.js";
import { runSkillsStep, type SkillsMethod } from "./init-skills.js";

// `argent init` orchestrator. Each phase below is a thin call into a dedicated
// module — the goal is for this file to read top-to-bottom like a recipe, with
// telemetry bookkeeping centralized in the shared InitTelemetry context. Step
// modules signal a cancelled prompt by throwing InitCancelled(step), which the
// catch below turns into the cli_init_cancel event + a clean exit.
export async function init(args: string[]): Promise<void> {
  const parsed = parseInitArgs(args);
  const initStartTime = performance.now();

  telemetryInit("installer");
  const tel = new InitTelemetry(initStartTime);

  try {
    printBanner();

    p.intro(pc.bgCyan(pc.black(" argent init ")));

    let version = getInstalledVersion() ?? "unknown";
    p.log.info(`${pc.dim("Package:")} ${PACKAGE_NAME}@${version}`);

    // Resolve telemetry consent before the first track() so the user's choice
    // governs whether this session's installation events are collected at all.
    const consent = await resolveTelemetryConsent({
      nonInteractive: parsed.nonInteractive,
      disableFlag: parsed.noTelemetry,
    });
    if (consent.kind === "cancelled") {
      // No tracking on a consent-prompt cancel — the user agreed to nothing.
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }

    track("installation:cli_init_start", {
      package_manager: detectPackageManager(),
      is_non_interactive: parsed.nonInteractive,
    });

    // ── Install mode: global (default) vs local (committable devDependency) ──────

    let modeFromFlags: InstallMode | null;
    try {
      modeFromFlags = resolveInstallModeFromFlags({
        local: parsed.wantsLocal,
        global: parsed.wantsGlobal,
        nonInteractive: parsed.nonInteractive,
      });
    } catch (err) {
      if (err instanceof InstallModeFlagError) {
        p.log.error(err.message);
        await tel.finalize(INSTALL_LOCAL_PRECONDITION_FAILED);
        process.exit(2);
      }
      throw err;
    }

    tel.installMode = modeFromFlags ?? (await promptInstallMode());
    track("installation:install_mode_decision", { install_mode: tel.installMode });

    // ── Step 0: Install / Update Check ──────────────────────────────────────────

    version = await runInstall({
      installMode: tel.installMode,
      fromTar: parsed.fromTar,
      nonInteractive: parsed.nonInteractive,
      version,
      tel,
    });

    // ── Step 1: MCP Server Configuration ────────────────────────────────────────

    p.log.step(pc.bold("Step 1: MCP Server Configuration"));

    const { selected: selectedAdapters, detected } = await chooseAdapters({
      nonInteractive: parsed.nonInteractive,
      installMode: tel.installMode,
    });
    tel.editorsConfiguredCount = selectedAdapters.length;
    p.log.info(`Editors: ${selectedAdapters.map((a) => pc.cyan(a.name)).join(", ")}`);

    const { scope, customRoot } = await chooseScope({
      installMode: tel.installMode,
      nonInteractive: parsed.nonInteractive,
    });
    const projectRoot = resolveProjectRoot(process.cwd());
    const effectiveRoot = scope === "custom" ? customRoot! : projectRoot;
    const normalizedScope: "local" | "global" = scope === "global" ? "global" : "local";

    const { adapters: writtenAdapters, lines: mcpLines } = writeMcpConfigs({
      selectedAdapters,
      installMode: tel.installMode,
      scope,
      effectiveRoot,
      projectRoot,
    });
    tel.editorsConfiguredCount = writtenAdapters.length;

    track("installation:editors_select", {
      editors: writtenAdapters.map((a) => sanitizeEditorName(a.name)),
      detected_editor_count: detected.length,
      scope,
      install_mode: tel.installMode,
    });

    p.note(mcpLines.join("\n"), "MCP Configuration");

    // Record local mode so `update`/`uninstall` and teammates act on the
    // repo-local install. Global mode stays zero-footprint (writes nothing) —
    // and clears a leftover local-mode record, which would otherwise win in
    // resolveInstallMode forever and keep `update`/`uninstall` targeting a
    // devDependency the user just switched away from.
    if (tel.installMode === "local") {
      try {
        writeInstallRecord(effectiveRoot, {
          mode: "local",
          package: PACKAGE_NAME,
          writtenBy: version,
        });
      } catch (err) {
        p.log.warn(`Could not write .argent/install.json: ${err}`);
      }
    } else if (removeInstallRecord(effectiveRoot)) {
      p.log.info(pc.dim("Removed stale .argent/install.json (previous local-mode marker)."));
    }

    // ── Tool Auto-Approval ────────────────────────────────────────────────────

    const allowlist = await configureAllowlist({
      adapters: writtenAdapters,
      effectiveRoot,
      scope: normalizedScope,
      nonInteractive: parsed.nonInteractive,
    });
    track("installation:allowlist_decision", { is_enabled: allowlist.enabled });
    if (allowlist.enabled && allowlist.lines.length > 0) {
      p.note(allowlist.lines.join("\n"), "Tool Auto-Approval");
    }

    // ── Step 2: Skills Installation ─────────────────────────────────────────────

    const skillsMethod = await runSkillsStep({
      nonInteractive: parsed.nonInteractive,
      fromTar: parsed.fromTar,
      version,
      scope,
      customRoot,
    });

    // ── Step 3: Rules and Agents ────────────────────────────────────────────────

    p.log.step(pc.bold("Step 3: Rules & Agents"));

    const copyResults = copyRulesAndAgents(
      writtenAdapters,
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

    // ── Summary ─────────────────────────────────────────────────────────────────

    printSummary({
      installMode: tel.installMode,
      selectedAdapters: writtenAdapters,
      scope,
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

    tel.initSucceeded = true;
    // Persist an interactive first-run telemetry choice only now that init has
    // completed. Until this point the pick governs the session via an in-process
    // override but isn't written to disk, so aborting setup leaves nothing behind
    // and the next run re-prompts instead of inheriting the abandoned choice.
    if ("commit" in consent) consent.commit();
    await tel.finalize();
  } catch (err) {
    if (err instanceof InitCancelled) {
      // A step module unwound on a cancelled prompt. Emit the matching cancel
      // event, drain telemetry, and exit cleanly.
      track("installation:cli_init_cancel", { step: err.step });
      await tel.finalize();
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }
    // Any unclassified throw (file I/O, copyRulesAndAgents, the online check, a
    // clack prompt) still drains buffered events and records a terminal
    // cli_init_complete before propagating to main().catch() in cli.ts.
    await tel.finalize(INSTALL_UNCLASSIFIED_FAILED);
    throw err;
  }
}

function sanitizeEditorName(raw: string): string {
  // Shape display names to the sanitizer's kebab-case adapter format.
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

interface SummaryArgs {
  installMode: InstallMode;
  selectedAdapters: McpConfigAdapter[];
  scope: Scope;
  allowlistEnabled: boolean;
  skillsMethod: SkillsMethod;
  copiedRules: boolean;
}

function printSummary({
  installMode,
  selectedAdapters,
  scope,
  allowlistEnabled,
  skillsMethod,
  copiedRules,
}: SummaryArgs): void {
  const summaryLines = [
    `${pc.green("Install mode")} ${installMode === "local" ? "local (devDependency)" : "global"}`,
    selectedAdapters.length > 0
      ? `${pc.green("MCP server")} configured for ${selectedAdapters.map((a) => a.name).join(", ")} (${scope})`
      : `${pc.yellow("MCP server")} NOT configured — no editor config was written`,
    `${pc.green("Auto-approve")} ${allowlistEnabled ? "enabled" : "skipped"}`,
    `${pc.green("Skills")} ${skillsMethod === "manual" ? "instructions printed" : "installed"}`,
    `${pc.green("Rules & agents")} ${copiedRules ? "copied" : "n/a"}`,
  ];

  p.note(summaryLines.join("\n"), "Summary");

  if (installMode === "local") {
    p.note(
      [
        `Argent is installed as a ${pc.bold("devDependency")} of this project.`,
        "",
        `${pc.bold("Commit")} so your team shares the same setup:`,
        `  ${pc.cyan("package.json")} + your lockfile`,
        `  the written MCP config (.mcp.json, .cursor/mcp.json, …)`,
        `  ${pc.cyan(".argent/install.json")}, and the skills/rules/agents files`,
        "",
        `Teammates then get argent on ${pc.cyan("npm install")} — no global install, no ${pc.cyan("argent init")}.`,
        pc.dim(
          "Note: the bare `argent` command will not be on their PATH; the MCP config runs the local copy."
        ),
      ].join("\n"),
      "Team Setup (local mode)"
    );
  }
}

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
  for (const line of lines) {
    console.log(line);
  }

  const attribution = "by Software Mansion";
  console.log(" ".repeat(width - attribution.length) + pc.dim(attribution));
  console.log();
}
