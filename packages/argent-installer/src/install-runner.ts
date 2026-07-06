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
  projectInstallCommand,
  formatShellCommand,
  resolveProjectRoot,
  hasProjectPackageJson,
  isGloballyInstalled,
  isDeclaredLocally,
  isLocallyInstalled,
  getLocallyInstalledVersion,
  isYarnPnp,
} from "./utils.js";
import { runShellCommand, runTrustingDisk } from "./shell.js";
import { PACKAGE_NAME } from "./constants.js";
import { reportSkillRefresh } from "./skills.js";
import type { InstallMode } from "./install-record.js";
import {
  InitTelemetry,
  INSTALL_GLOBAL_PACKAGE_FAILED,
  INSTALL_LOCAL_PACKAGE_FAILED,
  INSTALL_LOCAL_PRECONDITION_FAILED,
  INSTALL_FROM_TAR_PACKAGE_FAILED,
  INSTALL_INIT_TRIGGERED_UPDATE_FAILED,
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

  // Reuse only when the project's OWN package.json declares the dep AND it is
  // present on disk. Gating on mere resolvability (isLocallyInstalled) would
  // treat a hoisted workspace copy or a transitive dep as "already set up" and
  // skip the add — committing a local-mode config the manifest never backs, so
  // teammates' `npm install` wouldn't reliably get argent. If declared but not
  // yet materialized, fall through and install so node_modules is populated.
  if (isDeclaredLocally(projectRoot) && isLocallyInstalled(projectRoot) && !fromTar) {
    const startedAt = performance.now();
    p.log.info(`${PACKAGE_NAME} is already a devDependency ${pc.dim(`(${projectRoot})`)}.`);
    await tel.trackPackageAction("already_installed", startedAt, true);
    return;
  }

  const pm = detectProjectPackageManager(projectRoot);
  const installTarget = fromTar ?? PACKAGE_NAME;
  // Declared in the manifest but not materialized (a fresh clone): run the
  // plain project install, which honors the COMMITTED version pin. The `add`
  // form would resolve the bare package name to @latest and silently rewrite
  // the team's pin — the exact mutation `update` refuses on principle.
  const materializeOnly = isDeclaredLocally(projectRoot) && !fromTar;
  const cmd = materializeOnly ? projectInstallCommand(pm) : localInstallCommand(pm, installTarget);
  const cmdStr = formatShellCommand(cmd);
  const spinner = p.spinner();
  spinner.start(
    materializeOnly
      ? `Installing project dependencies to materialize ${PACKAGE_NAME} (${pm})...`
      : `Adding ${PACKAGE_NAME} to devDependencies (${pm})...`
  );
  const startedAt = performance.now();
  // Success is decided from the DISK, not the exit code (see runTrustingDisk —
  // pnpm 10+ exits non-zero on blocked build scripts). The probe: whether the
  // package is present after the run. isLocallyInstalled is PnP-aware (a Yarn
  // PnP project has no node_modules but declares the dep in-manifest); the
  // extra isYarnPnp keeps that leniency. A non-PnP layout with no node_modules
  // entry means the add really failed (a bad spec, ERR_PNPM_ADDING_TO_ROOT, a
  // network error) — don't write a config that runs a missing binary.
  const { landed, exitError: installError } = await runTrustingDisk(
    () => runShellCommand(cmd, { cwd: projectRoot }),
    () => isLocallyInstalled(projectRoot) || isYarnPnp(projectRoot)
  );

  if (!landed) {
    spinner.stop(pc.red("Local install failed."));
    p.log.error(
      installError
        ? `${installError}`
        : `The install reported success but ${pc.cyan(PACKAGE_NAME)} is not in node_modules.`
    );
    p.log.info(`Install manually with: ${pc.cyan(`cd ${projectRoot} && ${cmdStr}`)}`);
    await tel.trackPackageAction("fresh_install", startedAt, false, INSTALL_LOCAL_PACKAGE_FAILED);
    await tel.finalize(INSTALL_LOCAL_PACKAGE_FAILED);
    process.exit(1);
  }

  spinner.stop(
    pc.green(
      materializeOnly
        ? `Installed ${PACKAGE_NAME} from the committed dependency.`
        : `Added ${PACKAGE_NAME} to devDependencies.`
    )
  );

  if (installError) {
    // Installed, but the package manager still exited non-zero — almost always
    // pnpm's blocked build scripts. Say so plainly, and point pnpm users at the
    // optional approve-builds step for the native-only extras.
    p.log.warn(pc.dim(`${pm} exited non-zero but ${PACKAGE_NAME} is installed — continuing.`));
    if (pm === "pnpm") {
      p.log.info(
        pc.dim(
          `pnpm blocks dependency build scripts by default. ${PACKAGE_NAME} does not need them; ` +
            `run ${pc.cyan("pnpm approve-builds")} only if you want optional native features ` +
            `(e.g. source-level profiling).`
        )
      );
    }
  }

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
          reportSkillRefresh(resolveProjectRoot(process.cwd()), "installer_skills_refresh");
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
