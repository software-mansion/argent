import * as p from "@clack/prompts";
import pc from "picocolors";
import { execFileSync } from "node:child_process";
import semver from "semver";
import { init as telemetryInit, track } from "@argent/telemetry";
import { FAILURE_CODES, type FailureSignal } from "@argent/registry";
import {
  ALL_ADAPTERS,
  findConfiguredAdapterScopes,
  getMcpEntryForScope,
  resolveLocalCommandMode,
  copyRulesAndAgents,
  type McpConfigAdapter,
  type McpServerEntry,
} from "./mcp-configs.js";
import {
  getGloballyInstalledVersion,
  getGloballyInstalledPackageRoot,
  isGloballyInstalled,
  isNewerVersion,
  detectPackageManager,
  detectProjectPackageManager,
  globalInstallCommand,
  localInstallCommand,
  probeLocalInstall,
  resolveInstallMode,
  formatShellCommand,
  resolveProjectRoot,
  RULES_DIR,
  AGENTS_DIR,
  type InstallMode,
} from "./utils.js";
import {
  refreshArgentSkills,
  formatSkillRefreshSummary,
  summarizeSkillRefreshForTelemetry,
} from "./skills.js";
import { PACKAGE_NAME } from "./constants.js";
import { resolveInstallableUpdateTarget } from "./update-target.js";
import { killToolServerForInstallDir } from "@argent/tools-client";
import { finalizeTelemetry } from "./telemetry-finalize.js";
import { resolveTelemetryConsent } from "./first-run-notice.js";

function getRequestedVersion(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--version") {
      return args[i + 1] ?? null;
    }
    if (arg?.startsWith("--version=")) {
      return arg.slice("--version=".length) || null;
    }
  }
  return null;
}

type UpdateTrigger = "update" | "mcp_update";
type UpdatePackageAction = "standalone_update" | "standalone_install" | "mcp_update";

type InstallerFailureSignal = FailureSignal & { failure_area: "installer" };

const UPDATE_INSTALLED_VERSION_DETECT_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UPDATE_INSTALLED_VERSION_DETECT_FAILED,
  failure_stage: "installer_update_installed_version_detect",
  failure_area: "installer",
  error_kind: "unknown",
};

const UPDATE_INVALID_TARGET_VERSION: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UPDATE_INVALID_TARGET_VERSION,
  failure_stage: "installer_update_validate_target",
  failure_area: "installer",
  error_kind: "validation",
};

const UPDATE_REGISTRY_CHECK_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UPDATE_REGISTRY_CHECK_FAILED,
  failure_stage: "installer_update_registry_check",
  failure_area: "installer",
  error_kind: "network",
};

const UPDATE_TOOLSERVER_STOP_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UPDATE_TOOLSERVER_STOP_FAILED,
  failure_stage: "installer_update_toolserver_stop",
  failure_area: "installer",
  error_kind: "subprocess",
};

const UPDATE_PACKAGE_ACTION_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UPDATE_PACKAGE_ACTION_FAILED,
  failure_stage: "installer_update_package_action",
  failure_area: "installer",
  error_kind: "subprocess",
};

const UPDATE_UNCLASSIFIED_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UPDATE_UNCLASSIFIED_FAILED,
  failure_stage: "installer_update_unclassified",
  failure_area: "installer",
  error_kind: "unknown",
};

const INSTALL_SKILLS_REFRESH_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_SKILLS_REFRESH_FAILED,
  failure_stage: "installer_update_skills_refresh",
  failure_area: "installer",
  error_kind: "subprocess",
};

export function getUpdateTriggerFromEnv(env: NodeJS.ProcessEnv = process.env): UpdateTrigger {
  return env.ARGENT_UPDATE_TRIGGER === "mcp_update" ? "mcp_update" : "update";
}

export function resolveUpdatePackageAction(
  trigger: UpdateTrigger,
  installed: string | null
): UpdatePackageAction {
  if (trigger === "mcp_update") return "mcp_update";
  return installed ? "standalone_update" : "standalone_install";
}

export async function update(args: string[]): Promise<void> {
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  const noTelemetry = args.includes("--no-telemetry");
  const requestedVersion = getRequestedVersion(args);
  const trigger = getUpdateTriggerFromEnv();
  telemetryInit("installer");
  const updateStartTime = performance.now();
  let telemetryFinalized = false;
  // Resolved once Step 0 begins; reported on every terminal update event.
  let installMode: InstallMode = "global";

  const trackPackageAction = async (
    action: UpdatePackageAction | "no_update" | "update_skipped" | "update_failed",
    startedAt: number,
    isSuccess: boolean,
    failureSignal?: InstallerFailureSignal
  ): Promise<void> => {
    track("installation:package_action", {
      trigger,
      action,
      is_success: isSuccess,
      duration_ms: performance.now() - startedAt,
      ...(failureSignal ?? {}),
    });
  };

  const failUpdateTelemetry = async (failureSignal?: InstallerFailureSignal): Promise<void> => {
    if (telemetryFinalized) return;
    telemetryFinalized = true;
    await finalizeTelemetry(() => {
      track("installation:cli_update_fail", {
        duration_ms: performance.now() - updateStartTime,
        install_mode: installMode,
        ...(failureSignal ?? {}),
      });
    });
  };

  const completeUpdateTelemetry = async (): Promise<void> => {
    if (telemetryFinalized) return;
    telemetryFinalized = true;
    await finalizeTelemetry(() => {
      track("installation:cli_update_complete", {
        duration_ms: performance.now() - updateStartTime,
        install_mode: installMode,
      });
    });
  };

  try {
    p.intro(pc.bgCyan(pc.black(" argent update ")));

    // `--no-telemetry` force-disables before the first track(); otherwise just
    // surface the notice. update never prompts — it often runs from the old
    // binary or non-TTY contexts where the init consent step can't apply.
    await resolveTelemetryConsent({ nonInteractive: true, disableFlag: noTelemetry });

    track("installation:cli_update_start", {});

    // Mode decides what we update: the global PATH binary, or the project's
    // devDependency. The committed .argent/install.json wins; otherwise we infer
    // from an on-disk local install (resolveInstallMode), defaulting to global.
    const projectRoot = resolveProjectRoot(process.cwd());
    installMode = resolveInstallMode(projectRoot);

    // When invoked via `npx @swmansion/argent update`, the running package is the
    // npx cache and always at the latest published version. Reading PACKAGE_ROOT
    // would falsely report "already on the latest". We resolve the *real* install
    // the user has: the project's resolved copy in local mode (PnP-aware — a
    // Yarn PnP project has no node_modules but is still installed), or the
    // global binary's package.json in global mode.
    const localProbe = installMode === "local" ? probeLocalInstall(projectRoot) : null;
    const globallyInstalled = installMode === "global" && isGloballyInstalled();
    const isInstalledForMode = installMode === "local" ? localProbe!.installed : globallyInstalled;
    const installed =
      installMode === "local"
        ? localProbe!.version
        : globallyInstalled
          ? getGloballyInstalledVersion()
          : null;

    if (installMode === "global" && globallyInstalled && !installed) {
      await trackPackageAction(
        "update_failed",
        updateStartTime,
        false,
        UPDATE_INSTALLED_VERSION_DETECT_FAILED
      );
      await failUpdateTelemetry(UPDATE_INSTALLED_VERSION_DETECT_FAILED);
      p.log.error("Could not determine installed version.");
      process.exit(1);
    }

    const spinner = p.spinner();
    spinner.start("Checking for updates...");

    const pm =
      installMode === "local" ? detectProjectPackageManager(projectRoot) : detectPackageManager();
    let latest: string | null = null;
    let target: string | null = null;
    let minReleaseAgeMs = 0;

    if (requestedVersion !== null) {
      if (!semver.valid(requestedVersion) || semver.prerelease(requestedVersion)) {
        spinner.stop(pc.red("Invalid update target."));
        await trackPackageAction(
          "update_failed",
          updateStartTime,
          false,
          UPDATE_INVALID_TARGET_VERSION
        );
        await failUpdateTelemetry(UPDATE_INVALID_TARGET_VERSION);
        p.log.error(`Requested version is not a stable semver: ${requestedVersion}`);
        process.exit(1);
      }
      target = requestedVersion;
    } else {
      let resolved;
      try {
        resolved = await resolveInstallableUpdateTarget(pm, installed);
      } catch (err) {
        spinner.stop(pc.red("Could not reach registry."));
        await trackPackageAction(
          "update_failed",
          updateStartTime,
          false,
          UPDATE_REGISTRY_CHECK_FAILED
        );
        await failUpdateTelemetry(UPDATE_REGISTRY_CHECK_FAILED);
        p.log.error(`Failed to check registry: ${err}`);
        process.exit(1);
      }

      if (resolved === null) {
        spinner.stop(pc.red("Could not reach registry."));
        await trackPackageAction(
          "update_failed",
          updateStartTime,
          false,
          UPDATE_REGISTRY_CHECK_FAILED
        );
        await failUpdateTelemetry(UPDATE_REGISTRY_CHECK_FAILED);
        p.log.error("Failed to determine the latest Argent release from the registry.");
        process.exit(1);
      }

      latest = resolved.latestVersion;
      target = resolved.targetVersion;
      minReleaseAgeMs = resolved.minReleaseAgeMs;
    }

    spinner.stop("Version check complete.");

    if (installed) {
      p.log.info(`Installed: ${pc.cyan(`v${installed}`)}`);
    } else if (isInstalledForMode) {
      // Installed but the version can't be read — a Yarn PnP layout whose
      // manifest declares a range. Don't report "not installed" (and don't
      // reinstall on every run below).
      p.log.info(`Installed: ${pc.cyan("version unknown")} ${pc.dim("(Yarn PnP)")}`);
    } else {
      p.log.warn(
        installMode === "local"
          ? `${PACKAGE_NAME} is not installed in this project.`
          : `${PACKAGE_NAME} is not installed globally.`
      );
    }
    if (latest) {
      p.log.info(`Latest:    ${pc.cyan(`v${latest}`)}`);
    }
    if (target) {
      const label = latest && latest !== target ? "Target:    " : "Version:   ";
      const suffix = latest && latest !== target ? pc.dim(" (newest installable)") : "";
      p.log.info(`${label}${pc.cyan(`v${target}`)}${suffix}`);
    }

    // Installed-with-unknown-version (PnP + range specifier) must not read as
    // "not installed" — under --yes that would rewrite the manifest/lockfile on
    // EVERY run. Act on it only when the user explicitly requested a version.
    const versionUnknown = isInstalledForMode && installed === null;
    const needsInstall =
      target !== null &&
      (!isInstalledForMode ||
        (versionUnknown ? requestedVersion !== null : !installed || isNewerVersion(target, installed)));
    const latestIsNewer = latest !== null && (!installed || isNewerVersion(latest, installed));

    if (needsInstall && target !== null) {
      if (installed) {
        p.log.warn(`Update available: ${pc.yellow(`v${installed}`)} -> ${pc.green(`v${target}`)}`);
      }

      const cmd =
        installMode === "local"
          ? localInstallCommand(pm, `${PACKAGE_NAME}@${target}`)
          : globalInstallCommand(pm, `${PACKAGE_NAME}@${target}`);
      const cmdStr = formatShellCommand(cmd);

      if (!nonInteractive) {
        p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

        const proceed = await p.confirm({
          message: isInstalledForMode
            ? `Update to v${target}?`
            : installMode === "local"
              ? `Add ${PACKAGE_NAME}@${target} to this project's devDependencies?`
              : `Install ${PACKAGE_NAME}@${target} globally?`,
          initialValue: true,
        });

        if (p.isCancel(proceed) || !proceed) {
          await trackPackageAction("update_skipped", updateStartTime, true);
          await completeUpdateTelemetry();
          p.cancel(installed ? "Update cancelled." : "Install cancelled.");
          process.exit(0);
        }
      }

      p.log.info(`Running: ${pc.dim(cmdStr)}`);

      // Stop only the tool-server(s) spawned from the install we are about to
      // replace. Whatever the shared state tracks for a DIFFERENT install (the
      // global binary while updating a repo-local dep, or vice versa) may be
      // serving another editor session and must be left alone — same invariant
      // as the postinstall kill and the launcher's reuse gate. When the install
      // dir can't be resolved (fresh install, Yarn PnP) there is nothing of ours
      // to stop; the launcher's version-aware reuse gate retires a stale server
      // on the next call.
      const installDirToStop =
        installMode === "local" ? localProbe!.packageDir : getGloballyInstalledPackageRoot();
      try {
        if (installDirToStop) await killToolServerForInstallDir(installDirToStop);
      } catch (err) {
        await trackPackageAction(
          "update_failed",
          updateStartTime,
          false,
          UPDATE_TOOLSERVER_STOP_FAILED
        );
        await failUpdateTelemetry(UPDATE_TOOLSERVER_STOP_FAILED);
        p.log.error(`Could not stop the running tool server: ${err}`);
        process.exit(1);
      }

      const packageAction = resolveUpdatePackageAction(
        trigger,
        isInstalledForMode ? (installed ?? "unknown") : null
      );
      const packageActionStartedAt = performance.now();
      try {
        execFileSync(cmd.bin, cmd.args, {
          stdio: "inherit",
          env: { ...process.env, ARGENT_SKIP_POSTINSTALL: "1" },
          // Local installs must rewrite the project's manifest/lockfile.
          ...(installMode === "local" ? { cwd: projectRoot } : {}),
        });
      } catch (err) {
        await trackPackageAction(
          packageAction,
          packageActionStartedAt,
          false,
          UPDATE_PACKAGE_ACTION_FAILED
        );
        await failUpdateTelemetry(UPDATE_PACKAGE_ACTION_FAILED);
        p.log.error(`${installed ? "Update" : "Install"} failed: ${err}`);
        process.exit(1);
      }
      await trackPackageAction(packageAction, packageActionStartedAt, true);
    } else {
      await trackPackageAction("no_update", updateStartTime, true);
      if (versionUnknown) {
        p.log.warn(
          `Could not determine the installed version (Yarn PnP). ` +
            `Pass ${pc.cyan("--version <x.y.z>")} to update to a specific version.`
        );
      } else if (latest && target === null && latestIsNewer && minReleaseAgeMs > 0) {
        p.log.warn(
          `Latest version ${pc.cyan(`v${latest}`)} is still held by your minimum-release-age policy.`
        );
        p.log.info("No installable update is available yet.");
      } else if (latest && target && latest !== target) {
        p.log.success("Already on the latest installable version.");
      } else {
        p.log.success("Already on the latest version.");
      }
    }

    // Refresh configuration
    spinner.start("Refreshing workspace configuration...");

    const results: string[] = [];

    // Per scope: project-scope entries in local mode run the repo-local copy
    // (the bin path may have moved across versions); global scopes and global
    // mode keep the bare `argent` command.
    const localCmdMode = installMode === "local" ? resolveLocalCommandMode(projectRoot) : null;
    const entryFor = (scope: "local" | "global"): McpServerEntry =>
      getMcpEntryForScope(installMode, scope, localCmdMode);

    // Only refresh adapter scopes that already contain an argent entry. A
    // present editor dir (`.gemini`, `.cursor`, ...) is not consent — issue
    // #195 — so we look for the argent MCP server key in the actual config.
    const configuredScopes = findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot);
    const adaptersByScope = new Map<"local" | "global", Set<McpConfigAdapter>>([
      ["local", new Set()],
      ["global", new Set()],
    ]);

    for (const { adapter, scope, configPath } of configuredScopes) {
      const normScope = scope === "project" ? "local" : "global";
      try {
        adapter.write(configPath, entryFor(normScope));
        results.push(`${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`);
      } catch {
        // Skip paths that can't be written.
      }
      adaptersByScope.get(normScope)!.add(adapter);
    }

    // Refresh allowlists only for scopes that already had argent configured —
    // matches the editor list above.
    for (const [scope, adapters] of adaptersByScope) {
      for (const adapter of adapters) {
        if (!adapter.addAllowlist) continue;
        try {
          adapter.addAllowlist(projectRoot, scope);
        } catch {
          // non-fatal
        }
      }
    }

    // Refresh rules/agents the same way: per-scope, only for adapters the user
    // opted into in that scope.
    const localAdapters = [...adaptersByScope.get("local")!];
    const globalAdapters = [...adaptersByScope.get("global")!];
    const ruleResults = [
      ...copyRulesAndAgents(globalAdapters, projectRoot, "global", RULES_DIR, AGENTS_DIR),
      ...copyRulesAndAgents(localAdapters, projectRoot, "local", RULES_DIR, AGENTS_DIR),
    ];

    spinner.stop("Configuration refreshed.");

    if (results.length > 0) {
      p.note(results.join("\n"), "MCP Configs Updated");
    }

    if (ruleResults.length > 0) {
      p.note(ruleResults.join("\n"), "Rules & Agents Updated");
    }

    const skillRefreshResults = refreshArgentSkills(projectRoot);
    const skillSummary = formatSkillRefreshSummary(skillRefreshResults);
    if (skillSummary) {
      p.note(skillSummary, "Skills Updated");
    }
    const skillTelemetrySummary = summarizeSkillRefreshForTelemetry(skillRefreshResults);
    if (skillTelemetrySummary.scope_count > 0) {
      track("installation:skill_refresh_result", {
        is_success: skillTelemetrySummary.failed_count === 0,
        ...skillTelemetrySummary,
        ...(skillTelemetrySummary.failed_count > 0 ? INSTALL_SKILLS_REFRESH_FAILED : {}),
      });
    }

    await completeUpdateTelemetry();

    p.outro(pc.green("Update complete."));
  } catch (err) {
    await failUpdateTelemetry(UPDATE_UNCLASSIFIED_FAILED);
    throw err;
  }
}
