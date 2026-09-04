import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  init as telemetryInit,
  track,
  warmTelemetryIdentitySync,
  writeConsentFlag,
} from "@argent/telemetry";
import { ALL_ADAPTERS, copyRulesAndAgents, type McpConfigAdapter } from "./mcp-configs.js";
import {
  RULES_DIR,
  AGENTS_DIR,
  getInstalledVersion,
  detectPackageManager,
  resolveProjectRoot,
  resolveInstallModeFromFlags,
  InstallModeFlagError,
  isDeclaredLocally,
  readInstallRecord,
  writeInstallRecord,
  removeInstallRecord,
  type InstallMode,
} from "./utils.js";
import { PACKAGE_NAME } from "./constants.js";
import { resolveTelemetryConsent } from "./first-run-notice.js";
import { parseInitArgs, InitCancelled } from "./init-args.js";
import {
  InitTelemetry,
  INSTALL_MODE_FLAG_CONFLICT,
  INSTALL_UNCLASSIFIED_FAILED,
} from "./init-telemetry.js";
import { promptInstallMode } from "./init-mode-prompt.js";
import { runInstall } from "./install-runner.js";
import { chooseAdapters } from "./init-adapters.js";
import { chooseScope, type Scope } from "./init-scope.js";
import { writeMcpConfigs } from "./init-mcp-write.js";
import { cleanupStaleMcpConfigs } from "./init-stale-config.js";
import { configureAllowlist } from "./init-allowlist.js";
import { runSkillsStep, type SkillsMethod } from "./init-skills.js";

// `argent init` orchestrator. Step modules signal a cancelled prompt by throwing
// InitCancelled(step); the catch below turns that into cli_init_cancel + a clean exit.
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

    // Before the first track(), so the choice governs whether this session's
    // events are collected at all.
    const consent = await resolveTelemetryConsent({
      nonInteractive: parsed.nonInteractive,
      disableFlag: parsed.noTelemetry,
    });
    if (consent.kind === "cancelled") {
      // The user agreed to nothing, so emit nothing.
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }

    // Resolve the host fingerprint before the first event, so cli_init_start
    // carries the same distinct_id as every later event instead of a fallback the
    // background upgrade only migrates to mid-run. Sync by design: the async
    // variant awaits an unref'd resolver that never settles in a short-lived CLI.
    warmTelemetryIdentitySync();

    track("installation:cli_init_start", {
      package_manager: detectPackageManager(),
      is_non_interactive: parsed.nonInteractive,
    });

    // Seeds the non-interactive default and the prompt highlight, so re-running
    // init in a local-mode repo doesn't silently revert it to global. Absent a
    // record, a locally declared dependency is the same local-intent signal
    // update/uninstall honor via resolveInstallMode.
    const initProjectRoot = resolveProjectRoot(process.cwd());
    const recordedMode =
      readInstallRecord(initProjectRoot)?.mode ??
      (isDeclaredLocally(initProjectRoot) ? ("local" as const) : null);

    let modeFromFlags: InstallMode | null;
    try {
      modeFromFlags = resolveInstallModeFromFlags({
        local: parsed.wantsLocal,
        global: parsed.wantsGlobal,
        nonInteractive: parsed.nonInteractive,
        recordedMode,
      });
    } catch (err) {
      if (err instanceof InstallModeFlagError) {
        p.log.error(err.message);
        await tel.finalize(INSTALL_MODE_FLAG_CONFLICT);
        process.exit(2);
      }
      throw err;
    }

    tel.installMode = modeFromFlags ?? (await promptInstallMode(recordedMode ?? "global"));
    track("installation:install_mode_decision", { install_mode: tel.installMode });

    // `--local --no-telemetry`: the global opt-out above only covers this
    // machine. A local install is meant to be committed, so also record the
    // opt-out in the project config — `false` there wins on every clone.
    let wroteProjectTelemetryOptOut = false;
    if (parsed.noTelemetry && tel.installMode === "local") {
      try {
        writeConsentFlag(false, "project", { cwd: initProjectRoot });
        wroteProjectTelemetryOptOut = true;
        p.log.info(
          `${pc.bold("Telemetry")} ${pc.dim("also disabled for this project —")} ` +
            `${pc.cyan(".argent/config.json")} ${pc.dim("(commit it so the opt-out applies to every clone).")}`
        );
      } catch (err) {
        p.log.warn(`Could not write the project telemetry opt-out: ${err}`);
      }
    }

    // Step 0 — install / update check.

    version = await runInstall({
      installMode: tel.installMode,
      fromTar: parsed.fromTar,
      nonInteractive: parsed.nonInteractive,
      version,
      tel,
    });

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

    // Step 1d — see init-stale-config.ts for the remove-or-warn policy.
    const staleCleanup = await cleanupStaleMcpConfigs({
      writtenAdapters,
      // Every adapter, not just the detected set: the sweep only acts where an
      // argent entry already exists, and detection ignores dirs holding nothing
      // but argent's own artifacts (~/.cursor, ~/.codex).
      detectedAdapters: ALL_ADAPTERS,
      installMode: tel.installMode,
      scope: normalizedScope,
      effectiveRoot,
      // Removals in global config files get one confirmation: the "dead" verdict
      // is a PATH probe in THIS shell, which an nvm-style split can fool. No
      // confirmer non-interactively, so the sweep reports them instead.
      confirmCrossProjectRemovals: parsed.nonInteractive
        ? undefined
        : async (items) => {
            p.log.warn(
              `Dead argent entries from a previous global install were found in\n` +
                `  global (cross-project) config files:\n` +
                items.map((item) => `    ${pc.cyan(item)}`).join("\n")
            );
            const choice = await p.confirm({
              message: "Remove these dead global entries? - recommended",
              initialValue: true,
            });
            // Cancel declines the removal; the install is already written.
            return !p.isCancel(choice) && choice === true;
          },
    });
    if (staleCleanup.lines.length > 0) {
      p.note(staleCleanup.lines.join("\n"), "Stale Config Cleanup");
      track("installation:stale_config_cleanup", {
        removed_count: staleCleanup.removedCount,
        warned_count: staleCleanup.warnedCount,
      });
    }

    // Record local mode so `update`/`uninstall` and teammates act on the
    // repo-local install. Global mode writes nothing, and clears a leftover
    // local-mode record that would otherwise win in resolveInstallMode.
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
    } else {
      // Stale means the local install is gone: while the manifest still declares
      // the devDependency, the record describes a working — often committed,
      // team-shared — local install an `init --global` must not delete.
      if (isDeclaredLocally(effectiveRoot)) {
        if (readInstallRecord(effectiveRoot)) {
          p.log.info(
            pc.dim(
              `Kept .argent/install.json — this project still declares ${PACKAGE_NAME} as a ` +
                `devDependency, so it stays in local mode. To fully convert to a global ` +
                `install, run ${pc.cyan("argent uninstall --local")} first, then re-run ` +
                `${pc.cyan("argent init --global")}.`
            )
          );
        }
      } else if (removeInstallRecord(effectiveRoot)) {
        p.log.info(pc.dim("Removed stale .argent/install.json (previous local-mode marker)."));
      }
    }

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

    // Step 2 — the module prints its own step header.

    const skillsMethod = await runSkillsStep({
      nonInteractive: parsed.nonInteractive,
      fromTar: parsed.fromTar,
      version,
      scope,
      customRoot,
    });

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

    printSummary({
      installMode: tel.installMode,
      selectedAdapters: writtenAdapters,
      scope,
      allowlistEnabled: allowlist.enabled,
      skillsMethod,
      copiedRules: copyResults.length > 0,
      wroteProjectTelemetryOptOut,
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
    // completed: until here it is an in-process override, so an aborted setup
    // leaves nothing behind and the next run re-prompts.
    if ("commit" in consent) consent.commit();
    await tel.finalize();
  } catch (err) {
    if (err instanceof InitCancelled) {
      // A step module unwound on a cancelled prompt.
      track("installation:cli_init_cancel", { step: err.step });
      await tel.finalize();
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }
    // Any unclassified throw still drains buffered events and records a terminal
    // cli_init_complete before propagating to main().catch() in cli.ts.
    await tel.finalize(INSTALL_UNCLASSIFIED_FAILED);
    throw err;
  }
}

function sanitizeEditorName(raw: string): string {
  // Match the telemetry sanitizer's ADAPTER_NAME shape (kebab-case, <=64 chars).
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
  /** `--no-telemetry` in local mode also wrote `.argent/config.json`. */
  wroteProjectTelemetryOptOut: boolean;
}

function printSummary({
  installMode,
  selectedAdapters,
  scope,
  allowlistEnabled,
  skillsMethod,
  copiedRules,
  wroteProjectTelemetryOptOut,
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
        `  ${pc.cyan(".argent/install.json")}${wroteProjectTelemetryOptOut ? ` + ${pc.cyan(".argent/config.json")}` : ""}, and the skills/rules/agents files`,
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

function printBanner(): void {
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
