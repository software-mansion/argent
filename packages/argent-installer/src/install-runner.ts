import * as p from "@clack/prompts";
import pc from "picocolors";
import { track } from "@argent/telemetry";
import {
  getInstalledVersion,
  getGloballyInstalledVersion,
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
import { runShellCommand, runTrustingDisk, ShellCommandError } from "./shell.js";
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
// resolved version. Exits the process on a fatal install failure or a cancelled
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
  // on disk. Mere resolvability (isLocallyInstalled) could be a hoisted or
  // transitive copy the manifest never backs — teammates' `npm install`
  // wouldn't get argent. Declared but not materialized falls through to install.
  if (isDeclaredLocally(projectRoot) && isLocallyInstalled(projectRoot) && !fromTar) {
    const startedAt = performance.now();
    p.log.info(`${PACKAGE_NAME} is already a devDependency ${pc.dim(`(${projectRoot})`)}.`);
    await tel.trackPackageAction("already_installed", startedAt, true);
    return;
  }

  const pm = detectProjectPackageManager(projectRoot);
  const installTarget = fromTar ?? PACKAGE_NAME;
  // Declared but not materialized (fresh clone): run the plain project install,
  // which honors the committed version pin — `add` would resolve to @latest and
  // silently rewrite the team's pin.
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
  // pnpm 10+ exits non-zero on blocked build scripts). isYarnPnp covers PnP
  // layouts with no node_modules; otherwise a missing node_modules entry means
  // the add really failed — don't write a config that runs a missing binary.
  const attempt = (): Promise<{ landed: boolean; exitError: Error | null }> =>
    runTrustingDisk(
      () => runShellCommand(cmd, { cwd: projectRoot }),
      () => isLocallyInstalled(projectRoot) || isYarnPnp(projectRoot)
    );
  let lastAttemptStartedAt = performance.now();
  let retryCount = 0;
  let { landed, exitError: installError } = await attempt();

  // The project's package manager isn't on this machine at all (e.g. a cloned
  // pnpm repo where only npm is installed). Deterministic — don't retry; fail
  // with a message that names the real problem, because the generic "install
  // manually" advice fails the same way in the user's shell. POSIX spawns the
  // manager directly (ENOENT); Windows goes through cmd.exe (see
  // runShellCommand), which exits 9009 — cmd.exe's locale-independent
  // command-not-found code (its "is not recognized" stderr text is localized,
  // so it can't be matched).
  const isMissingBinaryError = (err: Error | null): boolean =>
    err !== null &&
    ((err as NodeJS.ErrnoException).code === "ENOENT" ||
      (process.platform === "win32" && err instanceof ShellCommandError && err.exitCode === 9009));
  const missingBinary = !landed && isMissingBinaryError(installError);

  // A signal-terminated install is a cancellation, not a transient failure —
  // retrying would silently spawn a second full install after the user (or CI
  // supervisor) killed the first one. Interactive Ctrl-C never reaches here
  // (clack's raw-mode stdin turns it into a keypress that exits argent), but a
  // signal-delivered SIGINT/SIGTERM (CI, `kill`, a timeout wrapper) surfaces
  // as `code null` + signal on the child.
  const wasInterrupted = (err: Error | null): boolean =>
    err instanceof ShellCommandError && (err.signal !== null || err.exitCode === null);
  const interrupted = !landed && wasInterrupted(installError);

  if (!landed && installError && !missingBinary && !interrupted) {
    // The package manager ran and failed. Retry once before giving up: first
    // attempts fail on transient registry/network errors (argent is a large
    // download) and on pnpm's own first-run state mutations (e.g. it may write
    // build-script policy stubs and exit non-zero), where an identical rerun
    // succeeds.
    spinner.message(`${pm} failed — retrying once...`);
    retryCount = 1;
    lastAttemptStartedAt = performance.now();
    ({ landed, exitError: installError } = await attempt());
  }

  // Retry visibility for the failure funnel: retry_count tells whether (and
  // how often) the retry fires and helps, and last_attempt_duration_ms keeps
  // the per-attempt duration fingerprint usable when duration_ms spans both
  // attempts (the fast-fail cluster that motivated the retry was identified
  // by exactly that signature).
  const attemptTelemetry = (): { retry_count: number; last_attempt_duration_ms: number } => ({
    retry_count: retryCount,
    last_attempt_duration_ms: performance.now() - lastAttemptStartedAt,
  });

  if (!landed) {
    spinner.stop(pc.red(interrupted ? "Local install interrupted." : "Local install failed."));
    if (missingBinary) {
      p.log.error(
        `This project uses ${pc.cyan(pm)}, but the ${pc.cyan(pm)} command was not found on PATH.`
      );
      p.log.info(
        `Install ${pc.cyan(pm)} first` +
          (pm === "pnpm" || pm === "yarn"
            ? ` (e.g. ${pc.cyan(`corepack enable ${pm}`)}, or see the ${pm} install docs)`
            : "") +
          `, then re-run ${pc.cyan("argent init --local")}.`
      );
    } else if (interrupted) {
      p.log.error(`The ${pc.cyan(pm)} install was interrupted before it finished.`);
      p.log.info(`Re-run ${pc.cyan("argent init --local")} to try again.`);
    } else {
      p.log.error(
        installError
          ? `${installError}`
          : `The install reported success but ${pc.cyan(PACKAGE_NAME)} is not in node_modules.`
      );
      p.log.info(`Install manually with: ${pc.cyan(`cd ${projectRoot} && ${cmdStr}`)}`);
    }
    await tel.trackPackageAction(
      "fresh_install",
      startedAt,
      false,
      INSTALL_LOCAL_PACKAGE_FAILED,
      attemptTelemetry()
    );
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
    // Installed, but the package manager exited non-zero — almost always pnpm's
    // blocked build scripts; point pnpm users at the optional approve-builds step.
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

  await tel.trackPackageAction("fresh_install", startedAt, true, undefined, attemptTelemetry());
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
    // No consent prompt here: the install-mode step directly above is where
    // the user chose "Globally" (or passed --global), and that choice IS the
    // consent to install the missing package — a second "install it?" select
    // reads as the same question asked twice.
    p.log.info(`Argent is not installed globally — installing.`);
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
      version = getGloballyInstalledVersion() ?? getInstalledVersion() ?? version;
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
      version = getGloballyInstalledVersion() ?? getInstalledVersion() ?? version;
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
  //
  // Compare the registry against the GLOBAL install's version, never the
  // running package's: under `npx ... init` the running package is the npx
  // cache — always latest — which would mask a stale global binary (the bug
  // topology.ts's getGloballyInstalledVersion exists for). That global version
  // also becomes this run's version — it is the install the written configs
  // run. If it can't be read (Windows argent.cmd wrapper hides the owning
  // package — see getGloballyInstalledPackageRoot), say so and skip the check
  // rather than fall back to the running package's version.
  const globalVersion = getGloballyInstalledVersion();
  version = globalVersion ?? version;
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

  if (latest && globalVersion === null) {
    p.log.warn(
      `Could not determine the global install's version — skipping the update check. ` +
        `Run ${pc.cyan("argent update")} to check for updates.`
    );
    await tel.trackPackageAction("no_update", packageActionStartedAt, true);
  } else if (latest && isNewerVersion(latest, version)) {
    const fromMajor = Number.parseInt(version.split(".")[0] ?? "0", 10) || 0;
    const toMajor = Number.parseInt(latest.split(".")[0] ?? "0", 10) || 0;
    if (nonInteractive) {
      // A --yes/CI install implicitly skips the update; emit the same
      // update_decision as the other branches so the upgrade funnel isn't blind.
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
          version = getGloballyInstalledVersion() ?? getInstalledVersion() ?? version;
          await tel.trackPackageAction("init_triggered_update", updateStartedAt, true);

          // Re-sync and prune argent skills in every scope that tracks them —
          // the only point in init that surfaces orphans from the old version
          // before Step 2's single-scope `skills add`.
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
