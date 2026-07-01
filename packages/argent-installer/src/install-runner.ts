import * as p from "@clack/prompts";
import pc from "picocolors";
import { track } from "@argent/telemetry";
import {
  getInstalledVersion,
  getLatestVersion,
  isNewerVersion,
  detectPackageManager,
  detectProjectPackageManager,
  globalInstallCommand,
  localInstallCommand,
  formatShellCommand,
  resolveProjectRoot,
  hasProjectPackageJson,
  isGloballyInstalled,
  isLocallyInstalled,
  getLocallyInstalledVersion,
  isYarnPnp,
} from "./utils.js";
import { runShellCommand } from "./shell.js";
import { PACKAGE_NAME } from "./constants.js";
import {
  refreshArgentSkills,
  formatSkillRefreshSummary,
  summarizeSkillRefreshForTelemetry,
} from "./skills.js";
import type { InstallMode } from "./install-record.js";
import {
  InitTelemetry,
  INSTALL_GLOBAL_PACKAGE_FAILED,
  INSTALL_LOCAL_PACKAGE_FAILED,
  INSTALL_LOCAL_PRECONDITION_FAILED,
  INSTALL_FROM_TAR_PACKAGE_FAILED,
  INSTALL_INIT_TRIGGERED_UPDATE_FAILED,
  INSTALL_SKILLS_REFRESH_FAILED,
} from "./init-telemetry.js";

// Step 0 — ensure argent is installed for the chosen mode and return the
// resolved version. Local: add the devDependency (or reuse an existing one).
// Global: install if missing, reinstall from --from, or offer an interactive
// update. Exits the process on a fatal install failure or a cancelled
// global-install prompt (each emitting its own terminal telemetry first).
export async function runInstall(args: {
  installMode: InstallMode;
  fromTar: string | null;
  nonInteractive: boolean;
  version: string;
  tel: InitTelemetry;
}): Promise<string> {
  const { installMode, fromTar, nonInteractive, tel } = args;

  if (installMode === "local") {
    await installLocally({ fromTar, tel });
    return getLocallyInstalledVersion(resolveProjectRoot(process.cwd())) ?? args.version;
  }

  return runGlobal({ fromTar, nonInteractive, version: args.version, tel });
}

// ── Local (committable devDependency) ─────────────────────────────────────────
// Exits the process on a missing package.json or a failed/empty install — the
// caller proceeds only once the dep is verified on disk (or is a known PnP
// layout, which has no node_modules).
async function installLocally(opts: { fromTar: string | null; tel: InitTelemetry }): Promise<void> {
  const { fromTar, tel } = opts;
  const projectRoot = resolveProjectRoot(process.cwd());

  if (!hasProjectPackageJson(projectRoot)) {
    p.log.error(
      `Local install needs a package.json at ${pc.cyan(projectRoot)}.\n` +
        `  Run ${pc.cyan("npm init -y")} there first, or use ${pc.cyan("argent init --global")}.`
    );
    await tel.trackPackageAction(
      "fresh_install",
      performance.now(),
      false,
      INSTALL_LOCAL_PRECONDITION_FAILED
    );
    await tel.finalize(INSTALL_LOCAL_PRECONDITION_FAILED);
    process.exit(1);
  }

  // Already a devDependency and not a developer `--from` reinstall → reuse it.
  if (isLocallyInstalled(projectRoot) && !fromTar) {
    const startedAt = performance.now();
    p.log.info(`${PACKAGE_NAME} is already a devDependency ${pc.dim(`(${projectRoot})`)}.`);
    await tel.trackPackageAction("already_installed", startedAt, true);
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
    await tel.trackPackageAction("fresh_install", startedAt, false, INSTALL_LOCAL_PACKAGE_FAILED);
    await tel.finalize(INSTALL_LOCAL_PACKAGE_FAILED);
    process.exit(1);
  }

  // Verify the dep actually landed. A non-PnP layout with no node_modules entry
  // means the install silently no-op'd; don't proceed to write a dead command.
  if (!isLocallyInstalled(projectRoot) && !isYarnPnp(projectRoot)) {
    spinner.stop(pc.red("Local install did not produce a node_modules entry."));
    p.log.error(
      `The install reported success but ${pc.cyan(PACKAGE_NAME)} is not in node_modules.`
    );
    await tel.trackPackageAction("fresh_install", startedAt, false, INSTALL_LOCAL_PACKAGE_FAILED);
    await tel.finalize(INSTALL_LOCAL_PACKAGE_FAILED);
    process.exit(1);
  }

  spinner.stop(pc.green(`Added ${PACKAGE_NAME} to devDependencies.`));
  await tel.trackPackageAction("fresh_install", startedAt, true);
}

// ── Global (PATH binary) ──────────────────────────────────────────────────────
async function runGlobal(opts: {
  fromTar: string | null;
  nonInteractive: boolean;
  version: string;
  tel: InitTelemetry;
}): Promise<string> {
  const { fromTar, nonInteractive, tel } = opts;
  let version = opts.version;
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
        await tel.finalize();
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
      await tel.trackPackageAction("fresh_install", packageActionStartedAt, true);
    } catch (err) {
      spinner.stop(pc.red("Installation failed."));
      p.log.error(`${err}`);
      p.log.info(`Install Argent manually with: ${pc.cyan(cmdStr)}`);
      await tel.trackPackageAction(
        "fresh_install",
        packageActionStartedAt,
        false,
        INSTALL_GLOBAL_PACKAGE_FAILED
      );
      await tel.finalize(INSTALL_GLOBAL_PACKAGE_FAILED);
      process.exit(1);
    }
    return version;
  }

  if (fromTar) {
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
      await tel.finalize(INSTALL_FROM_TAR_PACKAGE_FAILED);
      process.exit(1);
    }
    return version;
  }

  // Already installed → offer an interactive update.
  const packageActionStartedAt = performance.now();
  track("installation:global_install_decision", { decision: "already_installed" });
  await tel.trackPackageAction("already_installed", packageActionStartedAt, true);
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
      await tel.trackPackageAction("update_skipped", packageActionStartedAt, true);
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
        await tel.trackPackageAction("update_skipped", packageActionStartedAt, true);
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
          await tel.trackPackageAction("init_triggered_update", updateStartedAt, true);

          // The user just bumped to a newer argent. Re-sync and prune argent
          // skills in every scope that already tracks them — this is the only
          // point in init where we can surface orphans (skills removed from a
          // previous argent version) before Step 2's single-scope `skills add`.
          const skillRefreshResults = refreshArgentSkills(resolveProjectRoot(process.cwd()));
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
        } catch (err) {
          updateSpinner.stop(pc.red("Update failed."));
          p.log.error(`${err}`);
          p.log.info(`You can update manually later: ${pc.cyan(cmdStr)}`);
          await tel.trackPackageAction(
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
    await tel.trackPackageAction("no_update", packageActionStartedAt, true);
  }

  return version;
}
