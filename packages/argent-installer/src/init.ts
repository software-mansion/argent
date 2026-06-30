import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { init as telemetryInit, track } from "@argent/telemetry";
import { FAILURE_CODES, type FailureSignal } from "@argent/registry";
import {
  detectAdapters,
  ALL_ADAPTERS,
  getMcpEntry,
  resolveLocalCommandMode,
  copyRulesAndAgents,
  type McpConfigAdapter,
  type McpCommandMode,
  type McpServerEntry,
} from "./mcp-configs.js";
import {
  SKILLS_DIR,
  RULES_DIR,
  AGENTS_DIR,
  buildArgentSkillsSource,
  getInstalledVersion,
  getLatestVersion,
  isGloballyInstalled,
  isNewerVersion,
  isOnline,
  isSkillsCliAvailable,
  detectPackageManager,
  globalInstallCommand,
  formatShellCommand,
  resolveProjectRoot,
  withNpmForce,
  type ShellCommand,
  type InstallMode,
  resolveInstallModeFromFlags,
  InstallModeFlagError,
  localInstallCommand,
  detectProjectPackageManager,
  hasProjectPackageJson,
  isLocallyInstalled,
  getLocallyInstalledVersion,
  isYarnPnp,
  writeInstallRecord,
} from "./utils.js";
import {
  refreshArgentSkills,
  formatSkillRefreshSummary,
  summarizeSkillRefreshForTelemetry,
} from "./skills.js";
import { PACKAGE_NAME } from "./constants.js";
import { finalizeTelemetry } from "./telemetry-finalize.js";
import { resolveTelemetryConsent } from "./first-run-notice.js";

type InstallerFailureSignal = FailureSignal & { failure_area: "installer" };

const INSTALL_GLOBAL_PACKAGE_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_GLOBAL_PACKAGE_FAILED,
  failure_stage: "installer_global_package_install",
  failure_area: "installer",
  error_kind: "subprocess",
};

const INSTALL_LOCAL_PACKAGE_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_LOCAL_PACKAGE_FAILED,
  failure_stage: "installer_local_package_install",
  failure_area: "installer",
  error_kind: "subprocess",
};

const INSTALL_LOCAL_PRECONDITION_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_LOCAL_PRECONDITION_FAILED,
  failure_stage: "installer_local_precondition",
  failure_area: "installer",
  error_kind: "validation",
};

const INSTALL_FROM_TAR_PACKAGE_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_FROM_TAR_PACKAGE_FAILED,
  failure_stage: "installer_from_tar_package_install",
  failure_area: "installer",
  error_kind: "subprocess",
};

const INSTALL_INIT_TRIGGERED_UPDATE_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_INIT_TRIGGERED_UPDATE_FAILED,
  failure_stage: "installer_init_triggered_update",
  failure_area: "installer",
  error_kind: "subprocess",
};

const INSTALL_SKILLS_REFRESH_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_SKILLS_REFRESH_FAILED,
  failure_stage: "installer_skills_refresh",
  failure_area: "installer",
  error_kind: "subprocess",
};

// Catch-all for any unexpected throw that escapes the classified paths (file
// I/O, copyRulesAndAgents, the online check, a clack prompt). Without it the
// outer wrapper would drain telemetry but report no error code.
const INSTALL_UNCLASSIFIED_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_UNCLASSIFIED_FAILED,
  failure_stage: "installer_init_unclassified",
  failure_area: "installer",
  error_kind: "unknown",
};

function runShellCommand(cmd: ShellCommand, opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? `${cmd.bin}.cmd` : cmd.bin, cmd.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Command exited with code ${code}`));
    });

    child.on("error", reject);
  });
}

function extractFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1]!;
}

type PackageActionTracker = (
  action:
    | "fresh_install"
    | "already_installed"
    | "init_triggered_update"
    | "no_update"
    | "update_skipped"
    | "update_failed",
  startedAt: number,
  isSuccess: boolean,
  failureSignal?: InstallerFailureSignal
) => Promise<void>;

// Add @swmansion/argent to the project's devDependencies. Exits the process on a
// missing package.json or a failed/empty install — the caller proceeds only once
// the dep is verified on disk (or is a known PnP layout).
async function installLocally(opts: {
  fromTar: string | null;
  trackPackageAction: PackageActionTracker;
  finalizeInitTelemetry: (failureSignal?: InstallerFailureSignal) => Promise<void>;
}): Promise<void> {
  const { fromTar, trackPackageAction, finalizeInitTelemetry } = opts;
  const projectRoot = resolveProjectRoot(process.cwd());

  if (!hasProjectPackageJson(projectRoot)) {
    p.log.error(
      `Local install needs a package.json at ${pc.cyan(projectRoot)}.\n` +
        `  Run ${pc.cyan("npm init -y")} there first, or use ${pc.cyan("argent init --global")}.`
    );
    await trackPackageAction(
      "fresh_install",
      performance.now(),
      false,
      INSTALL_LOCAL_PRECONDITION_FAILED
    );
    await finalizeInitTelemetry(INSTALL_LOCAL_PRECONDITION_FAILED);
    process.exit(1);
  }

  // Already a devDependency and not a developer `--from` reinstall → reuse it.
  if (isLocallyInstalled(projectRoot) && !fromTar) {
    const startedAt = performance.now();
    p.log.info(`${PACKAGE_NAME} is already a devDependency ${pc.dim(`(${projectRoot})`)}.`);
    await trackPackageAction("already_installed", startedAt, true);
    return;
  }

  const pm = detectProjectPackageManager(projectRoot);
  const installTarget = fromTar ?? PACKAGE_NAME;
  const cmd = localInstallCommand(pm, installTarget);
  const cmdStr = formatShellCommand(cmd);
  const spinner = p.spinner();
  spinner.start(`Adding ${PACKAGE_NAME} to devDependencies (${pm})...`);
  const startedAt = performance.now();
  try {
    await runShellCommand(cmd, { cwd: projectRoot });
  } catch (err) {
    spinner.stop(pc.red("Local install failed."));
    p.log.error(`${err}`);
    p.log.info(`Install manually with: ${pc.cyan(`cd ${projectRoot} && ${cmdStr}`)}`);
    await trackPackageAction("fresh_install", startedAt, false, INSTALL_LOCAL_PACKAGE_FAILED);
    await finalizeInitTelemetry(INSTALL_LOCAL_PACKAGE_FAILED);
    process.exit(1);
  }

  // Verify the dep actually landed. A non-PnP layout with no node_modules entry
  // means the install silently no-op'd; don't proceed to write a dead command.
  if (!isLocallyInstalled(projectRoot) && !isYarnPnp(projectRoot)) {
    spinner.stop(pc.red("Local install did not produce a node_modules entry."));
    p.log.error(
      `The install reported success but ${pc.cyan(PACKAGE_NAME)} is not in node_modules.`
    );
    await trackPackageAction("fresh_install", startedAt, false, INSTALL_LOCAL_PACKAGE_FAILED);
    await finalizeInitTelemetry(INSTALL_LOCAL_PACKAGE_FAILED);
    process.exit(1);
  }

  spinner.stop(pc.green(`Added ${PACKAGE_NAME} to devDependencies.`));
  await trackPackageAction("fresh_install", startedAt, true);
}

export async function init(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  const noTelemetry = args.includes("--no-telemetry");
  const fromTar = extractFlag(args, "--from");
  const wantsLocal = args.includes("--local");
  const wantsGlobal = args.includes("--global");
  const initStartTime = performance.now();

  telemetryInit("installer");

  let editorsConfiguredCount = 0;
  let initSucceeded = false;
  let telemetryFinalized = false;
  // Resolved before Step 0; the closure below reports it on every terminal event.
  let installMode: InstallMode = "global";
  const finalizeInitTelemetry = async (failureSignal?: InstallerFailureSignal): Promise<void> => {
    if (telemetryFinalized) return;
    telemetryFinalized = true;
    await finalizeTelemetry(() => {
      track("installation:cli_init_complete", {
        duration_ms: performance.now() - initStartTime,
        is_success: initSucceeded,
        editors_configured_count: editorsConfiguredCount,
        install_mode: installMode,
        ...(failureSignal ?? {}),
      });
    });
  };

  const trackPackageAction = async (
    action:
      | "fresh_install"
      | "already_installed"
      | "init_triggered_update"
      | "no_update"
      | "update_skipped"
      | "update_failed",
    startedAt: number,
    isSuccess: boolean,
    failureSignal?: InstallerFailureSignal
  ): Promise<void> => {
    track("installation:package_action", {
      trigger: "init",
      action,
      is_success: isSuccess,
      duration_ms: performance.now() - startedAt,
      ...(failureSignal ?? {}),
    });
  };

  try {
    printBanner();

    p.intro(pc.bgCyan(pc.black(" argent init ")));

    let version = getInstalledVersion() ?? "unknown";
    p.log.info(`${pc.dim("Package:")} ${PACKAGE_NAME}@${version}`);

    // Resolve telemetry consent before the first track() so the user's choice
    // governs whether this session's installation events are collected at all.
    const consent = await resolveTelemetryConsent({ nonInteractive, disableFlag: noTelemetry });
    if (consent.kind === "cancelled") {
      // No tracking on a consent-prompt cancel — the user agreed to nothing.
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }

    track("installation:cli_init_start", {
      package_manager: detectPackageManager(),
      is_non_interactive: nonInteractive,
    });

    // ── Install mode: global (default) vs local (committable devDependency) ──────

    let modeFromFlags: InstallMode | null;
    try {
      modeFromFlags = resolveInstallModeFromFlags({
        local: wantsLocal,
        global: wantsGlobal,
        nonInteractive,
      });
    } catch (err) {
      if (err instanceof InstallModeFlagError) {
        p.log.error(err.message);
        await finalizeInitTelemetry(INSTALL_LOCAL_PRECONDITION_FAILED);
        process.exit(2);
      }
      throw err;
    }

    if (modeFromFlags !== null) {
      installMode = modeFromFlags;
    } else {
      const modeChoice = await p.select({
        message: "How should argent be installed?",
        options: [
          {
            value: "global" as const,
            label: "Globally (recommended)",
            hint: "Installs the argent command on your PATH; shared across every project",
          },
          {
            value: "local" as const,
            label: "This project only",
            hint: "Adds @swmansion/argent to devDependencies and commits MCP config that runs the local copy — best for teams",
          },
        ],
        initialValue: "global",
      });

      if (p.isCancel(modeChoice)) {
        track("installation:cli_init_cancel", { step: "install_mode" });
        await finalizeInitTelemetry();
        p.cancel("Initialization cancelled.");
        process.exit(0);
      }

      installMode = modeChoice as InstallMode;
    }

    track("installation:install_mode_decision", { install_mode: installMode });

    // ── Step 0: Install / Update Check ──────────────────────────────────────────

    if (installMode === "local") {
      await installLocally({
        fromTar,
        trackPackageAction,
        finalizeInitTelemetry,
      });
      version = getLocallyInstalledVersion(resolveProjectRoot(process.cwd())) ?? version;
    } else {
      const globallyInstalled = isGloballyInstalled();

      if (!globallyInstalled) {
        if (!nonInteractive) {
          const installChoice = await p.select({
            message: "Argent is not installed globally. Would you like to install it?",
            options: [
              {
                value: "global" as const,
                label: "Install globally",
                hint: "Makes the argent command available everywhere",
              },
              {
                value: "cancel" as const,
                label: "Cancel installation",
              },
            ],
          });

          if (p.isCancel(installChoice) || installChoice === "cancel") {
            track("installation:global_install_decision", { decision: "cancel" });
            track("installation:cli_init_cancel", { step: "global_install" });
            await finalizeInitTelemetry();
            p.cancel("Installation cancelled.");
            process.exit(0);
          }
        }

        track("installation:global_install_decision", { decision: "install" });

        const pm = detectPackageManager();
        const installTarget = fromTar ?? PACKAGE_NAME;
        const cmd = globalInstallCommand(pm, installTarget);
        const cmdStr = formatShellCommand(cmd);
        const spinner = p.spinner();
        spinner.start(`Installing ${PACKAGE_NAME} globally...`);
        const packageActionStartedAt = performance.now();
        try {
          await runShellCommand(cmd);
          spinner.stop(pc.green("Installed globally."));
          version = getInstalledVersion() ?? version;
          await trackPackageAction("fresh_install", packageActionStartedAt, true);
        } catch (err) {
          spinner.stop(pc.red("Installation failed."));
          p.log.error(`${err}`);
          p.log.info(`Install Argent manually with: ${pc.cyan(cmdStr)}`);
          await trackPackageAction(
            "fresh_install",
            packageActionStartedAt,
            false,
            INSTALL_GLOBAL_PACKAGE_FAILED
          );
          await finalizeInitTelemetry(INSTALL_GLOBAL_PACKAGE_FAILED);
          process.exit(1);
        }
      } else if (fromTar) {
        // Developer-only reinstall path; it is not a product install decision.
        const pm = detectPackageManager();
        const cmd = globalInstallCommand(pm, fromTar);
        const cmdStr = formatShellCommand(cmd);
        const spinner = p.spinner();
        spinner.start(`Installing from ${fromTar}...`);
        try {
          await runShellCommand(cmd);
          spinner.stop(pc.green("Installed from tarball."));
          version = getInstalledVersion() ?? version;
        } catch (err) {
          spinner.stop(pc.red("Installation failed."));
          p.log.error(`${err}`);
          p.log.info(`Install manually with: ${pc.cyan(cmdStr)}`);
          await finalizeInitTelemetry(INSTALL_FROM_TAR_PACKAGE_FAILED);
          process.exit(1);
        }
      } else {
        const packageActionStartedAt = performance.now();
        track("installation:global_install_decision", { decision: "already_installed" });
        await trackPackageAction("already_installed", packageActionStartedAt, true);
        let latest: string | null = null;
        const spinner = p.spinner();
        spinner.start("Checking for updates...");
        try {
          latest = getLatestVersion();
        } catch {
          // Registry unreachable — silently skip.
        }
        spinner.stop(pc.dim("Version check complete."));

        if (latest && isNewerVersion(latest, version)) {
          const fromMajor = Number.parseInt(version.split(".")[0] ?? "0", 10) || 0;
          const toMajor = Number.parseInt(latest.split(".")[0] ?? "0", 10) || 0;
          if (nonInteractive) {
            // A --yes/CI install with an available update implicitly skips it.
            // Emit the same update_decision the interactive and no-update branches
            // do, so the upgrade funnel isn't blind for non-interactive installs.
            track("installation:update_decision", {
              from_major: fromMajor,
              to_major: toMajor,
              decision: "skip",
            });
            await trackPackageAction("update_skipped", packageActionStartedAt, true);
          } else {
            const updateChoice = await p.select({
              message: `Update available: ${pc.yellow(`v${version}`)} → ${pc.green(`v${latest}`)}`,
              options: [
                {
                  value: "update" as const,
                  label: `Update to v${latest} (recommended)`,
                },
                {
                  value: "skip" as const,
                  label: "Skip",
                  hint: "Continue with current version",
                },
              ],
            });

            track("installation:update_decision", {
              from_major: fromMajor,
              to_major: toMajor,
              decision: p.isCancel(updateChoice) ? "skip" : (updateChoice as "update" | "skip"),
            });

            if (p.isCancel(updateChoice) || updateChoice === "skip") {
              await trackPackageAction("update_skipped", packageActionStartedAt, true);
            } else if (updateChoice === "update") {
              const pm = detectPackageManager();
              const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@${latest}`);
              const cmdStr = formatShellCommand(cmd);
              const updateSpinner = p.spinner();
              updateSpinner.start(`Updating to v${latest}...`);
              const updateStartedAt = performance.now();
              try {
                await runShellCommand(cmd);
                updateSpinner.stop(pc.green(`Updated to v${latest}.`));
                version = getInstalledVersion() ?? version;
                await trackPackageAction("init_triggered_update", updateStartedAt, true);

                // The user just bumped to a newer argent. Re-sync and prune
                // argent skills in every scope that already tracks them — this
                // is the only point in init where we can surface orphans
                // (skills removed from a previous argent version) before
                // Step 2's single-scope `skills add`.
                const skillRefreshResults = refreshArgentSkills(resolveProjectRoot(process.cwd()));
                const skillSummary = formatSkillRefreshSummary(skillRefreshResults);
                if (skillSummary) {
                  p.note(skillSummary, "Skills Updated");
                }
                const skillTelemetrySummary =
                  summarizeSkillRefreshForTelemetry(skillRefreshResults);
                if (skillTelemetrySummary.scope_count > 0) {
                  track("installation:skill_refresh_result", {
                    is_success: skillTelemetrySummary.failed_count === 0,
                    ...skillTelemetrySummary,
                    ...(skillTelemetrySummary.failed_count > 0
                      ? INSTALL_SKILLS_REFRESH_FAILED
                      : {}),
                  });
                }
              } catch (err) {
                updateSpinner.stop(pc.red("Update failed."));
                p.log.error(`${err}`);
                p.log.info(`You can update manually later: ${pc.cyan(cmdStr)}`);
                await trackPackageAction(
                  "update_failed",
                  updateStartedAt,
                  false,
                  INSTALL_INIT_TRIGGERED_UPDATE_FAILED
                );
              }
            }
          }
        } else if (latest) {
          const fromMajor = Number.parseInt(version.split(".")[0] ?? "0", 10) || 0;
          const toMajor = Number.parseInt(latest.split(".")[0] ?? "0", 10) || 0;
          track("installation:update_decision", {
            from_major: fromMajor,
            to_major: toMajor,
            decision: "no_update",
          });
          await trackPackageAction("no_update", packageActionStartedAt, true);
        }
      }
    }

    // ── Step 1: MCP Server Configuration ────────────────────────────────────────

    p.log.step(pc.bold("Step 1: MCP Server Configuration"));

    const detected = detectAdapters();
    const detectedNames = detected.map((a) => a.name);

    let selectedAdapters: McpConfigAdapter[];

    if (nonInteractive) {
      selectedAdapters = detected.length > 0 ? detected : ALL_ADAPTERS;
    } else {
      const choices = ALL_ADAPTERS.map((a) => {
        const parts: string[] = [];
        if (detectedNames.includes(a.name)) parts.push("detected");
        const hasProject = a.projectPath(process.cwd()) != null;
        const hasGlobal = a.globalPath() != null;
        if (!hasProject && hasGlobal) {
          parts.push(pc.italic(pc.cyan(`ⓘ  will be installed into ${a.name}'s global config`)));
        } else if (hasProject && !hasGlobal) {
          parts.push(pc.italic(pc.cyan(`ⓘ  will be installed into ${a.name}'s project config`)));
        }
        return {
          value: a,
          label: a.name,
          hint: parts.length > 0 ? parts.join(", ") : undefined,
        };
      });

      p.log.message(pc.dim("  Use arrow keys to move, space to toggle, enter to confirm."));

      const selected = await p.multiselect({
        message: "Which editors should Argent be configured for?",
        options: choices,
        initialValues: detected,
        required: true,
      });

      if (p.isCancel(selected)) {
        track("installation:cli_init_cancel", { step: "editors" });
        await finalizeInitTelemetry();
        p.cancel("Initialization cancelled.");
        process.exit(0);
      }

      selectedAdapters = selected as McpConfigAdapter[];
    }

    editorsConfiguredCount = selectedAdapters.length;
    p.log.info(`Editors: ${selectedAdapters.map((a) => pc.cyan(a.name)).join(", ")}`);

    // Ask scope: global, local, or custom path
    let scope: "local" | "global" | "custom";
    let customRoot: string | undefined;

    if (installMode === "local") {
      // Local mode commits project files; a global-scope MCP config makes no
      // sense for a repo-local install, so the project root is always the target.
      scope = "local";
    } else if (nonInteractive) {
      scope = "local";
    } else {
      p.log.message(pc.dim("  Use arrow keys to move, enter to confirm."));

      const scopeChoice = await p.select({
        message: "Install MCP server globally or locally?",
        options: [
          {
            value: "local" as const,
            label: "Local",
            hint: "Current project only - .cursor/mcp.json, .mcp.json, ...",
          },
          {
            value: "global" as const,
            label: "Global",
            hint: "Available across all projects - ~/.*/mcp.json",
          },
          {
            value: "custom" as const,
            label: "Specify installation directory",
            hint: "Specify a directory to use as the project root",
          },
        ],
      });

      if (p.isCancel(scopeChoice)) {
        track("installation:cli_init_cancel", { step: "scope" });
        await finalizeInitTelemetry();
        p.cancel("Initialization cancelled.");
        process.exit(0);
      }

      scope = scopeChoice as "local" | "global" | "custom";

      if (scope === "custom") {
        const customPathInput = await p.text({
          message: "Enter the path to use as the project root for MCP config:",
          placeholder: process.cwd(),
          validate(value) {
            if (!value?.trim()) return "Path cannot be empty.";
            const resolved = resolve(value.trim());
            if (!existsSync(resolved))
              return `Path does not exist: ${resolved}. Please verify and enter a valid path.`;
          },
        });

        if (p.isCancel(customPathInput)) {
          track("installation:cli_init_cancel", { step: "scope" });
          await finalizeInitTelemetry();
          p.cancel("Initialization cancelled.");
          process.exit(0);
        }

        customRoot = resolve((customPathInput as string).trim());
      }
    }

    const projectRoot = resolveProjectRoot(process.cwd());
    const effectiveRoot = scope === "custom" ? customRoot! : projectRoot;
    const normalizedScope: "local" | "global" = scope === "global" ? "global" : "local";

    // Local mode writes project-scoped entries that run the repo-local argent.
    // Global-only adapters (no project config file) can't carry that, so drop
    // them with a note rather than writing a global `argent` entry that would
    // depend on the global install the user opted out of.
    let localCmdMode: McpCommandMode | null = null;
    if (installMode === "local") {
      localCmdMode = resolveLocalCommandMode(effectiveRoot);
      const unsupported = selectedAdapters.filter((a) => a.projectPath(effectiveRoot) == null);
      if (unsupported.length > 0) {
        p.log.warn(
          `Skipping ${unsupported.map((a) => a.name).join(", ")} — ` +
            `no project-level config file (local mode commits project files only).`
        );
        selectedAdapters = selectedAdapters.filter((a) => a.projectPath(effectiveRoot) != null);
        editorsConfiguredCount = selectedAdapters.length;
      }
      if (localCmdMode.kind === "local-npx") {
        p.log.warn(
          `Could not resolve a project-local argent binary; committing ` +
            `${pc.cyan("npx --no-install argent mcp")}. Run ${pc.cyan("npm install")} so it resolves.`
        );
      }
    }

    track("installation:editors_select", {
      editors: selectedAdapters.map((a) => sanitizeEditorName(a.name)),
      detected_editor_count: detected.length,
      scope,
      install_mode: installMode,
    });

    // Global scope (and global install mode) always gets the bare `argent`
    // command; only a local-mode project-scope entry runs the repo-local copy.
    const entryFor = (configScope: "local" | "global"): McpServerEntry =>
      installMode === "local" && configScope === "local" && localCmdMode
        ? getMcpEntry(localCmdMode)
        : getMcpEntry({ kind: "global" });
    const mcpResults: string[] = [];

    for (const adapter of selectedAdapters) {
      const configPath =
        scope === "global" ? adapter.globalPath() : adapter.projectPath(effectiveRoot);

      if (!configPath) {
        if (scope === "global" && adapter.projectPath(projectRoot)) {
          const fallback = adapter.projectPath(projectRoot)!;
          try {
            adapter.write(fallback, entryFor("local"));
            mcpResults.push(
              `${pc.green("+")} ${adapter.name} ${pc.dim(`(local fallback: ${fallback})`)}`
            );
          } catch (err) {
            mcpResults.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
          }
        } else if (scope !== "global" && adapter.globalPath()) {
          const fallback = adapter.globalPath()!;
          try {
            adapter.write(fallback, entryFor("global"));
            mcpResults.push(
              `${pc.green("+")} ${adapter.name} ${pc.dim(`(global fallback: ${fallback})`)}`
            );
          } catch (err) {
            mcpResults.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
          }
        } else {
          mcpResults.push(
            `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no config path for this scope)")}`
          );
        }
        continue;
      }

      try {
        adapter.write(configPath, entryFor(normalizedScope));
        mcpResults.push(`${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`);
      } catch (err) {
        mcpResults.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
      }
    }

    p.note(mcpResults.join("\n"), "MCP Configuration");

    // Record local mode so `update`/`uninstall` and teammates act on the
    // repo-local install. Global mode stays zero-footprint (writes nothing).
    if (installMode === "local") {
      try {
        writeInstallRecord(effectiveRoot, {
          mode: "local",
          package: PACKAGE_NAME,
          writtenBy: version,
        });
      } catch (err) {
        p.log.warn(`Could not write .argent/install.json: ${err}`);
      }
    }

    // ── Tool Auto-Approval ────────────────────────────────────────────────────

    const adaptersWithAllowlist = selectedAdapters.filter((a) => a.addAllowlist);
    const adaptersWithoutAllowlist = selectedAdapters.filter((a) => !a.addAllowlist);

    let allowlistEnabled = false;

    if (adaptersWithAllowlist.length > 0) {
      p.log.info(
        `By default, editors ask for confirmation before running each MCP tool.\n` +
          `  Adding Argent to the auto-approve allowlist lets tools run without\n` +
          `  repeated prompts. This is ${pc.cyan("recommended")} for a smooth experience.`
      );

      if (nonInteractive) {
        allowlistEnabled = true;
      } else {
        p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

        const allowlistChoice = await p.confirm({
          message: "Add Argent tools to editor auto-approve lists? - recommended",
          initialValue: true,
        });

        if (p.isCancel(allowlistChoice)) {
          track("installation:cli_init_cancel", { step: "allowlist" });
          await finalizeInitTelemetry();
          p.cancel("Initialization cancelled.");
          process.exit(0);
        }

        allowlistEnabled = allowlistChoice as boolean;
      }
    }

    track("installation:allowlist_decision", {
      is_enabled: allowlistEnabled,
    });

    if (allowlistEnabled) {
      const allowlistResults: string[] = [];

      for (const adapter of adaptersWithAllowlist) {
        const hasPath =
          normalizedScope === "global" ? adapter.globalPath() : adapter.projectPath(effectiveRoot);
        if (!hasPath) {
          allowlistResults.push(
            `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no config for this scope)")}`
          );
          continue;
        }

        try {
          adapter.addAllowlist!(effectiveRoot, normalizedScope);
          allowlistResults.push(`${pc.green("+")} ${adapter.name}`);
        } catch (err) {
          allowlistResults.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
        }
      }

      for (const adapter of adaptersWithoutAllowlist) {
        allowlistResults.push(
          `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no auto-approve API - configure manually)")}`
        );
      }

      p.note(allowlistResults.join("\n"), "Tool Auto-Approval");
    }

    // ── Step 2: Skills Installation ─────────────────────────────────────────────

    p.log.step(pc.bold("Step 2: Skills Installation"));
    p.log.warn(pc.yellow("Skills installation is required for Argent to function properly."));

    type SkillsMethod = "default" | "interactive" | "manual";
    let skillsMethod: SkillsMethod;

    const online = await isOnline();
    const offlineWithCache = !online && isSkillsCliAvailable();
    const skillsCliReady = online || offlineWithCache;

    if (!skillsCliReady) {
      p.log.warn(
        pc.yellow("You appear to be offline. ") +
          "Automatic skills installation requires a network connection."
      );
    }

    if (!skillsCliReady) {
      skillsMethod = "manual";
    } else if (nonInteractive) {
      skillsMethod = "default";
    } else {
      p.log.message(pc.dim("  Use arrow keys to move, enter to confirm."));

      const choice = await p.select({
        message: "How would you like to install skills?",
        options: [
          {
            value: "default" as const,
            label: "Automatic",
            hint: "Installs all skills automatically with npx skills",
          },
          {
            value: "interactive" as const,
            label: "Interactive",
            hint: "Full npx skills TUI - choose skills, agents, and method",
          },
          {
            value: "manual" as const,
            label: "Manual",
            hint: "Print instructions for manual installation",
          },
        ],
      });

      if (p.isCancel(choice)) {
        track("installation:cli_init_cancel", { step: "skills" });
        await finalizeInitTelemetry();
        p.cancel("Initialization cancelled.");
        process.exit(0);
      }

      skillsMethod = choice as SkillsMethod;
    }

    // Prefer the GitHub-pinned source. SKILLS_DIR as a fallback.
    const useGitHubSource = online && !fromTar && version !== "unknown";
    const skillsSource = useGitHubSource ? buildArgentSkillsSource(version) : SKILLS_DIR;

    let skillOutcome: "success" | "failure" | "skipped";

    if (skillsMethod === "manual") {
      p.note(
        [
          `Skills are bundled at:`,
          `  ${pc.cyan(SKILLS_DIR)}`,
          ``,
          `To install manually, copy them to your editor's skills directory:`,
          ``,
          `  ${pc.dim("# Claude Code")}`,
          `  cp -r ${SKILLS_DIR}/* ${scope === "global" ? "~/.claude/skills/" : `${scope === "custom" ? customRoot! : "."}/.claude/skills/`}`,
          ``,
          `  ${pc.dim("# Cursor")}`,
          `  cp -r ${SKILLS_DIR}/* ${scope === "global" ? "~/.cursor/skills/" : `${scope === "custom" ? customRoot! : "."}/.cursor/skills/`}`,
          ``,
          `  ${pc.dim("# Or use npx skills directly:")}`,
          `  npx skills add ${skillsSource}`,
        ].join("\n"),
        "Manual Skills Installation"
      );
      skillOutcome = "skipped";
    } else {
      const skillsArgs = ["skills", "add", skillsSource];

      if (scope === "global") {
        skillsArgs.push("-g");
      }

      if (skillsMethod === "default") {
        skillsArgs.push("--skill", "*", "-y");
      }

      const baseArgs = offlineWithCache ? ["--no-install", ...skillsArgs] : skillsArgs;
      // The spawned command carries `--force` to soften the host project's npm
      // engine gate (see withNpmForce / issue #298). The displayed and
      // manual-fallback commands stay clean so users see the real `npx skills`.
      const npxArgs = withNpmForce(baseArgs);

      p.log.info(`Running: ${pc.dim("npx")} ${pc.cyan(baseArgs.join(" "))}`);

      const spinner = p.spinner();
      if (skillsMethod === "default") {
        spinner.start("Installing skills...");
      }

      try {
        const skillsCwd = scope === "custom" ? customRoot : undefined;
        await runNpxSkills(npxArgs, skillsMethod === "interactive", skillsCwd);
        if (skillsMethod === "default") {
          spinner.stop("Skills installed.");
        }
        skillOutcome = "success";
      } catch (err) {
        if (skillsMethod === "default") {
          spinner.stop(pc.red("Skills installation failed."));
        }
        p.log.error(`Failed to run npx skills: ${err}`);
        p.log.info(`You can install skills manually:\n  npx ${skillsArgs.join(" ")}`);
        skillOutcome = "failure";
      }
    }

    track("installation:skill_install", {
      method: skillsMethod,
      is_online: online,
      has_offline_cache: offlineWithCache,
      outcome: skillOutcome,
    });

    // ── Step 3: Rules and Agents ────────────────────────────────────────────────

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

    // ── Summary ─────────────────────────────────────────────────────────────────

    const summaryLines = [
      `${pc.green("Install mode")} ${installMode === "local" ? "local (devDependency)" : "global"}`,
      `${pc.green("MCP server")} configured for ${selectedAdapters.map((a) => a.name).join(", ")} (${scope})`,
      `${pc.green("Auto-approve")} ${allowlistEnabled ? "enabled" : "skipped"}`,
      `${pc.green("Skills")} ${skillsMethod === "manual" ? "instructions printed" : "installed"}`,
      `${pc.green("Rules & agents")} ${copyResults.length > 0 ? "copied" : "n/a"}`,
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

    initSucceeded = true;
    // Persist an interactive first-run telemetry choice only now that init has
    // completed. Until this point the pick governs the session via an in-process
    // override but isn't written to disk, so aborting setup leaves nothing behind
    // and the next run re-prompts instead of inheriting the abandoned choice.
    if ("commit" in consent) consent.commit();
    await finalizeInitTelemetry();
  } catch (err) {
    // Any unclassified throw (file I/O, copyRulesAndAgents, the online check, a
    // clack prompt) still drains buffered events and records a terminal
    // cli_init_complete before propagating to main().catch() in cli.ts.
    await finalizeInitTelemetry(INSTALL_UNCLASSIFIED_FAILED);
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

export function runNpxSkills(args: string[], interactive: boolean, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(npxCmd, args, {
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      ...(cwd ? { cwd } : {}),
    });

    let stdout = "";
    let stderr = "";

    if (!interactive) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const output = [stderr, stdout].filter(Boolean).join("\n").trim();
        reject(new Error(output || `npx skills exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}
