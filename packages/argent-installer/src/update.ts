import * as p from "@clack/prompts";
import pc from "picocolors";
import * as path from "node:path";
import semver from "semver";
import { init as telemetryInit, track, warmTelemetryIdentitySync } from "@argent/telemetry";
import { FAILURE_CODES, type FailureSignal } from "@argent/registry";
import {
  ALL_ADAPTERS,
  detectAdapters,
  findConfiguredAdapterScopes,
  getMcpEntryForScope,
  isArgentManagedEntry,
  resolveLocalCommandMode,
  copyRulesAndAgents,
  type McpConfigAdapter,
  type McpServerEntry,
} from "./mcp-configs.js";
import { cleanupStaleMcpConfigs } from "./init-stale-config.js";
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
  getLocallyInstalledVersion,
  readLocalPackageVersionUncached,
  hasProjectPackageJson,
  isDeclaredLocally,
  resolveInstallMode,
  formatShellCommand,
  resolveProjectRoot,
  RULES_DIR,
  AGENTS_DIR,
  type InstallMode,
} from "./utils.js";
import { parseTargetFlags, decideInstallTargets, promptInstallTargets } from "./install-targets.js";
import { execShellCommandSync, runTrustingDisk } from "./shell.js";
import { probeGlobalInstallTarget, unwritableGlobalTargetMessage } from "./global-prefix.js";
import { reportSkillRefresh } from "./skills.js";
import { PACKAGE_NAME } from "./constants.js";
import { resolveInstallableUpdateTarget } from "./update-target.js";
import { killToolServer, killToolServerForInstallDir } from "@argent/tools-client";
import { finalizeTelemetry } from "./telemetry-finalize.js";
import { resolveTelemetryConsent } from "./first-run-notice.js";
import { canPromptUser, noTerminalMessage } from "./terminal.js";

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

// Explicit pin from the update-argent tool, which already resolved which
// project's local install it targets. Re-deriving via resolveProjectRoot can
// land on a different monorepo ancestor and silently no-op the update.
function getProjectRootOverride(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project-root") {
      return args[i + 1] ?? null;
    }
    if (arg?.startsWith("--project-root=")) {
      return arg.slice("--project-root=".length) || null;
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

const UPDATE_GLOBAL_PREFIX_UNWRITABLE: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UPDATE_GLOBAL_PREFIX_UNWRITABLE,
  failure_stage: "installer_update_global_prefix_preflight",
  failure_area: "installer",
  error_kind: "validation",
};

const UPDATE_NEEDS_TERMINAL: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UPDATE_NEEDS_TERMINAL,
  failure_stage: "installer_update_prompt",
  failure_area: "installer",
  error_kind: "validation",
};

const UPDATE_UNCLASSIFIED_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.UPDATE_UNCLASSIFIED_FAILED,
  failure_stage: "installer_update_unclassified",
  failure_area: "installer",
  error_kind: "unknown",
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
  // The project's mode (resolveInstallMode below); reported on the terminal
  // update events and keys the config refresh.
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

  // Version-check + install for ONE install target. EVERY outcome returns: a
  // hard failure on one target must not abort the run mid-loop and skip
  // another target's update or the refresh. The caller aggregates — "failed"
  // carries the signal for the terminal telemetry event and exit code;
  // "updated" / "declined" / "noop" decide whether the refresh runs.
  const applyUpdateForTarget = async (
    mode: InstallMode,
    projectRoot: string
  ): Promise<"updated" | "declined" | "noop" | { failed: InstallerFailureSignal }> => {
    // Disclose the target before any mutation.
    if (mode === "local") {
      p.log.info(
        `Target: ${pc.cyan("local install")} — this project's ${PACKAGE_NAME} ` +
          `devDependency ${pc.dim(`(${projectRoot})`)}.`
      );
    } else {
      p.log.info(`Target: ${pc.cyan("global install")} — the argent command on your PATH.`);
    }

    // Under `npx @swmansion/argent update` the running package is the npx
    // cache, always at the latest published version — PACKAGE_ROOT would
    // falsely report "already on the latest". Resolve the *real* install.
    const localProbe = mode === "local" ? probeLocalInstall(projectRoot) : null;
    const globallyInstalled = mode === "global" && isGloballyInstalled();
    const isInstalledForMode = mode === "local" ? localProbe!.installed : globallyInstalled;
    const installed =
      mode === "local"
        ? localProbe!.version
        : globallyInstalled
          ? getGloballyInstalledVersion()
          : null;

    if (mode === "global" && globallyInstalled && !installed) {
      await trackPackageAction(
        "update_failed",
        updateStartTime,
        false,
        UPDATE_INSTALLED_VERSION_DETECT_FAILED
      );
      p.log.error("Could not determine installed version.");
      return { failed: UPDATE_INSTALLED_VERSION_DETECT_FAILED };
    }

    // A resolvable copy the project never opted into (no committed .argent
    // record, no declaration in its own manifest) is not this project's
    // install — install-record.ts's intent rule, the gate uninstall applies
    // too. The package-manager add would ADD a devDependency and rewrite a
    // lockfile uninvited. Yarn PnP probes already imply a declaration.
    if (
      mode === "local" &&
      localProbe?.installed &&
      installMode !== "local" &&
      !isDeclaredLocally(projectRoot)
    ) {
      p.log.warn(
        `${PACKAGE_NAME} is resolvable from this project but is not declared in its package.json.`
      );
      p.log.info(
        `A hoisted or transitive copy is not this project's install. Run ` +
          `${pc.cyan("argent init --local")} to adopt it as a devDependency, or ` +
          `${pc.cyan("argent update --global")} for the global install.`
      );
      await trackPackageAction("no_update", updateStartTime, true);
      return "noop";
    }

    // Local mode but nothing installed (fresh clone, or a marker at a root
    // with no manifest). The package-manager add is wrong either way: it
    // rewrites the team's committed version pin to @latest, and with no
    // package.json it walks up and mutates an unrelated ancestor project.
    if (mode === "local" && localProbe && !localProbe.installed) {
      p.log.warn(`${PACKAGE_NAME} is not installed in this project yet.`);
      if (isDeclaredLocally(projectRoot)) {
        p.log.info(
          `It is declared in package.json — run your package manager's install ` +
            `(e.g. ${pc.cyan("npm install")}), then re-run ${pc.cyan("argent update")}.`
        );
      } else if (hasProjectPackageJson(projectRoot)) {
        // `--local` on a project that doesn't depend on argent: adding and
        // half-configuring a devDependency is init's job.
        p.log.info(
          `It is not a dependency of this project. Run ${pc.cyan("argent init --local")} to add it, ` +
            `or ${pc.cyan("argent update --global")} for the global install.`
        );
      } else {
        p.log.info(
          `No package.json at ${pc.cyan(projectRoot)}. Run ${pc.cyan("argent init")} in the ` +
            `project directory, or remove ${pc.cyan(".argent/install.json")}.`
        );
      }
      await trackPackageAction("no_update", updateStartTime, true);
      return "noop";
    }

    // The agent-triggered updater acts on an UPDATE consent, never an install
    // consent: a missing global install must not be created here, however the
    // target was reached.
    if (trigger === "mcp_update" && mode === "global" && !globallyInstalled) {
      p.log.warn(`${PACKAGE_NAME} is not installed globally — nothing to update.`);
      await trackPackageAction("no_update", updateStartTime, true);
      return "noop";
    }

    const spinner = p.spinner();
    spinner.start("Checking for updates...");

    const pm = mode === "local" ? detectProjectPackageManager(projectRoot) : detectPackageManager();
    let latest: string | null = null;
    let target: string | null;
    let minReleaseAgeMs = 0;

    if (requestedVersion !== null) {
      // Validated once, before the target loop.
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
        p.log.error(`Failed to check registry: ${err}`);
        return { failed: UPDATE_REGISTRY_CHECK_FAILED };
      }

      if (resolved === null) {
        spinner.stop(pc.red("Could not reach registry."));
        await trackPackageAction(
          "update_failed",
          updateStartTime,
          false,
          UPDATE_REGISTRY_CHECK_FAILED
        );
        p.log.error("Failed to determine the latest Argent release from the registry.");
        return { failed: UPDATE_REGISTRY_CHECK_FAILED };
      }

      latest = resolved.latestVersion;
      target = resolved.targetVersion;
      minReleaseAgeMs = resolved.minReleaseAgeMs;
    }

    spinner.stop("Version check complete.");

    if (installed) {
      p.log.info(`Installed: ${pc.cyan(`v${installed}`)}`);
    } else if (isInstalledForMode) {
      // Installed but the version is unreadable (Yarn PnP with a range
      // specifier) — reporting "not installed" would reinstall every run.
      p.log.info(`Installed: ${pc.cyan("version unknown")} ${pc.dim("(Yarn PnP)")}`);
    } else {
      p.log.warn(
        mode === "local"
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
    // EVERY run. Act on it only for an explicit --version.
    const versionUnknown = isInstalledForMode && installed === null;
    const needsInstall =
      target !== null &&
      (!isInstalledForMode ||
        (versionUnknown
          ? requestedVersion !== null
          : !installed || isNewerVersion(target, installed)));
    const latestIsNewer = latest !== null && (!installed || isNewerVersion(latest, installed));

    if (needsInstall && target !== null) {
      if (installed) {
        p.log.warn(`Update available: ${pc.yellow(`v${installed}`)} -> ${pc.green(`v${target}`)}`);
      }

      // An unwritable global directory fails HERE — before the confirm prompt,
      // and before the tool-server teardown below stops a server for an install
      // that was never going to be replaced.
      if (mode === "global") {
        const globalTarget = probeGlobalInstallTarget(pm, getGloballyInstalledPackageRoot());
        if (globalTarget?.blocked) {
          await trackPackageAction(
            "update_failed",
            updateStartTime,
            false,
            UPDATE_GLOBAL_PREFIX_UNWRITABLE
          );
          p.log.error(unwritableGlobalTargetMessage(globalTarget, pm, "update"));
          return { failed: UPDATE_GLOBAL_PREFIX_UNWRITABLE };
        }
      }

      const cmd =
        mode === "local"
          ? localInstallCommand(pm, `${PACKAGE_NAME}@${target}`)
          : globalInstallCommand(pm, `${PACKAGE_NAME}@${target}`);
      const cmdStr = formatShellCommand(cmd);

      if (!nonInteractive) {
        if (!canPromptUser()) {
          p.log.error(noTerminalMessage("argent update"));
          await trackPackageAction("update_failed", updateStartTime, false, UPDATE_NEEDS_TERMINAL);
          return { failed: UPDATE_NEEDS_TERMINAL };
        }

        p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

        const proceed = await p.confirm({
          message: isInstalledForMode
            ? `Update to v${target}?`
            : mode === "local"
              ? `Add ${PACKAGE_NAME}@${target} to this project's devDependencies?`
              : `Install ${PACKAGE_NAME}@${target} globally?`,
          initialValue: true,
        });

        if (p.isCancel(proceed) || !proceed) {
          await trackPackageAction("update_skipped", updateStartTime, true);
          p.log.info(pc.dim(`Skipped the ${mode} install.`));
          return "declined";
        }
      }

      p.log.info(`Running: ${pc.dim(cmdStr)}`);

      // Stop only tool-server(s) from the install we're replacing — a
      // DIFFERENT install's server may be serving another editor session (same
      // invariant as the launcher's reuse gate and dead-bundle sweep). An
      // unresolvable install dir (fresh install, Yarn PnP) means nothing of
      // ours to stop; the reuse gate retires a stale server on the next call.
      const installDirToStop =
        mode === "local" ? localProbe!.packageDir : getGloballyInstalledPackageRoot();
      try {
        if (installDirToStop) {
          await killToolServerForInstallDir(installDirToStop);
        } else if (mode === "global") {
          // The global package root can be unresolvable (Windows .cmd-wrapper
          // layouts — see getGloballyInstalledPackageRoot). Fall back to the
          // legacy single-slot record, which only older argent versions write.
          await killToolServer();
        }
      } catch (err) {
        await trackPackageAction(
          "update_failed",
          updateStartTime,
          false,
          UPDATE_TOOLSERVER_STOP_FAILED
        );
        p.log.error(`Could not stop the running tool server: ${err}`);
        return { failed: UPDATE_TOOLSERVER_STOP_FAILED };
      }

      const packageAction = resolveUpdatePackageAction(
        trigger,
        isInstalledForMode ? (installed ?? "unknown") : null
      );
      const packageActionStartedAt = performance.now();
      // Success is decided from the DISK, not the exit code (see
      // runTrustingDisk — pnpm 10+ exits non-zero on blocked build scripts).
      let landedVersion: string | null = null;
      const { landed: reachedTarget, exitError: installError } = await runTrustingDisk(
        () => {
          execShellCommandSync(cmd, {
            // Current versions ship no postinstall, but downgrades and pinned
            // installs fetch older ones whose postinstall honors this — keep it
            // so they stay quiet and don't double-kill the tool server.
            env: { ...process.env, ARGENT_SKIP_POSTINSTALL: "1" },
            // Local installs must rewrite the project's manifest/lockfile.
            ...(mode === "local" ? { cwd: projectRoot } : {}),
          });
        },
        () => {
          landedVersion =
            mode === "local"
              ? // Cache-free: the pre-install probe memoized the old version's
                // realpath, so getLocallyInstalledVersion would read it stale.
                (readLocalPackageVersionUncached(projectRoot) ??
                getLocallyInstalledVersion(projectRoot))
              : getGloballyInstalledVersion();
          // `target` is narrowed non-null by the enclosing if; the closure
          // re-widens it, hence the assertion.
          return landedVersion !== null && !isNewerVersion(target!, landedVersion);
        }
      );
      if (installError) {
        if (!reachedTarget) {
          await trackPackageAction(
            packageAction,
            packageActionStartedAt,
            false,
            UPDATE_PACKAGE_ACTION_FAILED
          );
          p.log.error(`${installed ? "Update" : "Install"} failed: ${installError}`);
          return { failed: UPDATE_PACKAGE_ACTION_FAILED };
        }
        p.log.warn(
          pc.dim(
            `Your package manager exited non-zero but ${PACKAGE_NAME}@${landedVersion} is installed — continuing.`
          )
        );
      } else if (landedVersion !== null && !reachedTarget) {
        // The disk verdict cuts BOTH ways: a clean exit whose target version
        // did not land (nvm/prefix split) is a failure, not an update. Only a
        // null landedVersion (unreadable, e.g. Yarn PnP) leaves the exit code
        // authoritative.
        await trackPackageAction(
          packageAction,
          packageActionStartedAt,
          false,
          UPDATE_PACKAGE_ACTION_FAILED
        );
        p.log.error(
          `${installed ? "Update" : "Install"} reported success but v${landedVersion} is still ` +
            `what resolves for the ${mode} install (expected v${target}). ` +
            (mode === "global"
              ? `Check that your package manager's global prefix matches the \`argent\` on your PATH.`
              : `Check the project's node_modules layout.`)
        );
        return { failed: UPDATE_PACKAGE_ACTION_FAILED };
      }
      await trackPackageAction(packageAction, packageActionStartedAt, true);
      return "updated";
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
      } else if (
        requestedVersion !== null &&
        installed &&
        !isNewerVersion(requestedVersion, installed)
      ) {
        // A --version at or below the installed one is a no-op, not "latest".
        p.log.success(
          `Requested v${requestedVersion} is not newer than the installed v${installed} — nothing to do.`
        );
      } else {
        p.log.success("Already on the latest version.");
      }
    }
    return "noop";
  };

  try {
    p.intro(pc.bgCyan(pc.black(" argent update ")));

    // `--no-telemetry` force-disables before the first track(); otherwise just
    // surface the notice. update never prompts for consent — it often runs
    // detached or from the old binary, where init's consent step can't apply.
    await resolveTelemetryConsent({ nonInteractive: true, disableFlag: noTelemetry });

    // Establish the identity before the first event so cli_update_start carries
    // the stable per-machine fingerprint, not a fallback id migrated to later —
    // same as init.ts before cli_init_start. SYNC by design: the async warm
    // awaits an unref'd resolver that would exit a short-lived CLI.
    warmTelemetryIdentitySync();

    track("installation:cli_update_start", {});

    // Validate --version once, up front: it applies to every target alike, so
    // it must fail the run before any target acts on it.
    if (
      requestedVersion !== null &&
      (!semver.valid(requestedVersion) || semver.prerelease(requestedVersion))
    ) {
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

    // The committed .argent/install.json (else a manifest declaration) decides
    // the project's mode. Which install(s) to update is a separate choice.
    const rootOverride = getProjectRootOverride(args);
    const projectRoot = rootOverride
      ? path.resolve(rootOverride)
      : resolveProjectRoot(process.cwd());
    installMode = resolveInstallMode(projectRoot);

    // Explicit flags win; a lone PRESENT install is used as-is; a coexisting
    // global + local pair prompts, or acts on both non-interactively. Presence
    // is what matters: a local-mode repo whose devDependency isn't
    // materialized yet (fresh clone) must not shadow a present global install.
    const flags = parseTargetFlags(args);
    const localInstalled = installMode === "local" && probeLocalInstall(projectRoot).installed;
    const globalInstalled = isGloballyInstalled();
    const defaultTarget: InstallMode = localInstalled
      ? "local"
      : globalInstalled
        ? "global"
        : installMode;
    // An explicit --local run gets the detailed guidance from
    // applyUpdateForTarget instead of this one-liner.
    if (installMode === "local" && !localInstalled && !flags.local) {
      p.log.warn(
        `${PACKAGE_NAME} is declared for this project but not installed — run your package ` +
          `manager's install, or ${pc.cyan("argent update --local")} for guidance.`
      );
    }
    const decision = decideInstallTargets({
      globalPresent: globalInstalled,
      localPresent: localInstalled,
      defaultTarget,
      flags,
      nonInteractive,
      nonInteractiveBothDefault: ["global", "local"],
    });

    let targets: InstallMode[];
    if (decision.kind === "prompt") {
      if (!canPromptUser()) {
        p.log.error(noTerminalMessage("argent update"));
        await trackPackageAction("update_failed", updateStartTime, false, UPDATE_NEEDS_TERMINAL);
        await failUpdateTelemetry(UPDATE_NEEDS_TERMINAL);
        p.outro(pc.red("Update failed."));
        process.exit(1);
      }

      const picked = await promptInstallTargets("update");
      if (picked === "cancel") {
        await completeUpdateTelemetry();
        p.cancel("Update cancelled.");
        process.exit(0);
      }
      targets = picked;
    } else {
      targets = decision.targets;
      if (decision.reason === "noninteractive-both") {
        p.log.info(
          pc.dim(
            "Both a global and a project-local install were found; updating both " +
              "(pass --global or --local to narrow)."
          )
        );
      }
    }

    const outcomes: Array<"updated" | "declined" | "noop" | "failed"> = [];
    let firstFailure: InstallerFailureSignal | null = null;
    for (const mode of targets) {
      const outcome = await applyUpdateForTarget(mode, projectRoot);
      if (typeof outcome === "object") {
        firstFailure ??= outcome.failed;
        outcomes.push("failed");
      } else {
        outcomes.push(outcome);
      }
    }

    // A declined prompt with nothing updated ends the run: the refresh (entry
    // rewrites, allowlists, stale-config removals, skills) would mutate files
    // the user just refused to have touched. A partial run (one declined,
    // another updated) still refreshes — the applied update needs its config.
    if (outcomes.includes("declined") && !outcomes.includes("updated") && !firstFailure) {
      await completeUpdateTelemetry();
      p.cancel("Update cancelled.");
      process.exit(0);
    }

    // Nothing updated and a target hard-failed: failure telemetry, exit 1, no
    // refresh. A partial run with an "updated" target falls through — it still
    // needs its refresh, and the failure resurfaces in the exit code below.
    if (firstFailure && !outcomes.includes("updated")) {
      await failUpdateTelemetry(firstFailure);
      p.outro(pc.red("Update failed."));
      process.exit(1);
    }

    // The refresh is keyed on the PROJECT's mode (installMode), not the install
    // just updated: a local-mode project keeps its committed node-path command
    // even when only the global install was bumped.
    {
      const spinner = p.spinner();
      spinner.start("Refreshing workspace configuration...");

      const results: string[] = [];

      // Project-scope entries in local mode run the repo-local copy (the bin
      // path may move across versions); global scopes keep the bare `argent`.
      const localCmdMode = installMode === "local" ? resolveLocalCommandMode(projectRoot) : null;
      // Never REWRITE existing entries to the degraded npx fallback: local-npx
      // only means the repo-local bin can't be resolved right now (fresh clone,
      // pruned pnpm store), and the committed node-path command is right again
      // once the install materializes. (init still writes the fallback from
      // scratch, with its own warning.)
      const skipEntryRewrite = localCmdMode?.kind === "local-npx";
      const entryFor = (scope: "local" | "global"): McpServerEntry =>
        getMcpEntryForScope(installMode, scope, localCmdMode);

      // Only scopes that already contain an argent entry: a present editor dir
      // (`.gemini`, `.cursor`, ...) is not consent — issue #195.
      const configuredScopes = findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot);
      const adaptersByScope = new Map<"local" | "global", Set<McpConfigAdapter>>([
        ["local", new Set()],
        ["global", new Set()],
      ]);

      // Classify BEFORE writing: an entry argent didn't author (custom command,
      // extra args, env vars) is a deliberate override — rewriting it would
      // destroy the customization AND launder it into a bare shape the
      // stale-config sweep below could judge dead and delete. Everything else is
      // rewritten unconditionally; the write also REPAIRS state the normalized
      // view can't see (an opencode `enabled: false`, or getArgentEntry's
      // unreadable sentinel { command: "" }).
      for (const { adapter, scope, configPath } of configuredScopes) {
        const normScope = scope === "project" ? "local" : "global";
        // Allowlists and rules still refresh for this adapter either way — only
        // the MCP entry itself is protected.
        adaptersByScope.get(normScope)!.add(adapter);
        if (skipEntryRewrite && normScope === "local") continue;
        let existing: McpServerEntry | null;
        try {
          existing = adapter.getArgentEntry(configPath);
        } catch {
          continue;
        }
        const isUnreadableSentinel =
          existing !== null && existing.command === "" && existing.args.length === 0;
        if (existing !== null && !isUnreadableSentinel && !isArgentManagedEntry(existing)) {
          results.push(
            `${pc.yellow("!")} ${adapter.name} left a customized entry untouched ${pc.dim(configPath)}`
          );
          continue;
        }
        try {
          adapter.write(configPath, entryFor(normScope));
          results.push(`${pc.green("+")} ${adapter.name} ${pc.dim(configPath)}`);
        } catch {
          // Skip paths that can't be written.
        }
      }
      if (skipEntryRewrite && configuredScopes.some(({ scope }) => scope === "project")) {
        p.log.info(
          pc.dim(
            "Left project MCP entries unchanged — the repo-local argent binary can't be " +
              "resolved right now (fresh checkout: run your package manager's install; " +
              "after an out-of-band version bump, just re-run argent update)."
          )
        );
      }

      // Allowlists only for scopes that already had argent configured.
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

      // Rules/agents the same way: only adapters opted into in that scope.
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

      // The same stale-config sweep init runs (its step 1d): configs the
      // refresh did not rewrite can still shadow or block the refreshed entries
      // (a `claude mcp add` leftover, a dead global entry after a global→local
      // migration, a recorded .mcp.json rejection).
      const staleCleanup = await cleanupStaleMcpConfigs({
        writtenAdapters: [...new Set([...localAdapters, ...globalAdapters])],
        detectedAdapters: detectAdapters(),
        installMode,
        scope: localAdapters.length > 0 ? "local" : "global",
        effectiveRoot: projectRoot,
        // Same one-shot confirmation init uses for cross-project removals.
        // An update with nobody to ask — --yes, or no terminal — passes no
        // confirmer and the sweep reports instead of removing: an unattended
        // run must never delete cross-project state on a fallible PATH probe.
        // A terminal-less run gets this far whenever it had nothing to install,
        // which is the only question asked before here.
        confirmCrossProjectRemovals:
          nonInteractive || !canPromptUser()
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

      if (ruleResults.length > 0) {
        p.note(ruleResults.join("\n"), "Rules & Agents Updated");
      }

      reportSkillRefresh(projectRoot, "installer_update_skills_refresh");
    }

    if (firstFailure) {
      // Partial run: one target updated (its refresh just ran), another
      // hard-failed. Exit code and telemetry must not read as success.
      await failUpdateTelemetry(firstFailure);
      p.outro(pc.yellow("Update finished with errors — see above."));
      process.exit(1);
    }

    await completeUpdateTelemetry();

    p.outro(pc.green("Update complete."));
  } catch (err) {
    await failUpdateTelemetry(UPDATE_UNCLASSIFIED_FAILED);
    throw err;
  }
}
