import * as path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { track } from "@argent/telemetry";
import {
  getInstalledVersion,
  getGloballyInstalledPackageRoot,
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
import type { PackageManager } from "./package-manager.js";
import { runShellCommand, runTrustingDisk, ShellCommandError } from "./shell.js";
import {
  blockedGlobalTargetCause,
  forgetInheritedNpmPrefix,
  localInstallRemedy,
  probeGlobalInstallTarget,
  suggestedNpmPrefix,
  unwritableGlobalTargetMessage,
  type GlobalInstallTarget,
} from "./global-prefix.js";
import { PACKAGE_NAME } from "./constants.js";
import { reportSkillRefresh } from "./skills.js";
import type { InstallMode } from "./install-record.js";
import { InitCancelled } from "./init-args.js";
import {
  InitTelemetry,
  INSTALL_GLOBAL_PACKAGE_FAILED,
  INSTALL_GLOBAL_PREFIX_UNWRITABLE,
  INSTALL_LOCAL_PACKAGE_FAILED,
  INSTALL_LOCAL_PRECONDITION_FAILED,
  INSTALL_FROM_TAR_PACKAGE_FAILED,
  INSTALL_INIT_TRIGGERED_UPDATE_FAILED,
} from "./init-telemetry.js";

export interface InstallOutcome {
  version: string;
  /**
   * Mode the install actually landed in. A global install whose target
   * directory cannot be written can be recovered as a local one, and every
   * later step of init — configs, scope, install record — follows this, not
   * the mode originally asked for.
   */
  installMode: InstallMode;
  /**
   * Directory the argent binary now lives in that the user's shells do not
   * know about yet. Set only by the prefix recovery, whose global MCP config
   * names a bare `argent` — so until this is on PATH, the editors init just
   * configured cannot start it.
   */
  pathHint: string | null;
}

// Step 0 — ensure argent is installed and report the version and mode the rest
// of init should work against. Exits the process on a fatal install failure or
// a cancelled prompt (each emitting its own terminal telemetry first).
export async function runInstall(args: {
  installMode: InstallMode;
  fromTar: string | null;
  nonInteractive: boolean;
  version: string;
  /**
   * Where a fresh global install would land, probed by the caller so the
   * install-mode prompt and the install itself agree without querying the
   * package manager twice. Null when no fresh global install is in play.
   */
  globalTarget: GlobalInstallTarget | null;
  /**
   * The install-mode step already showed that `globalTarget` cannot be written
   * and named what argent would do about it, and the user chose global anyway.
   * That choice is the answer, so the recovery carries the remedy out instead
   * of asking the same question a second time.
   */
  globalBlockAcknowledged: boolean;
  tel: InitTelemetry;
}): Promise<InstallOutcome> {
  const { installMode, fromTar, nonInteractive, globalTarget, globalBlockAcknowledged, tel } = args;

  if (installMode === "local") {
    await installLocally({ fromTar, tel });
    return { version: localVersion(args.version), installMode: "local", pathHint: null };
  }

  return runGlobal({
    fromTar,
    nonInteractive,
    version: args.version,
    globalTarget,
    globalBlockAcknowledged,
    tel,
  });
}

function localVersion(fallback: string): string {
  return getLocallyInstalledVersion(resolveProjectRoot(process.cwd())) ?? fallback;
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

/**
 * Offer the two ways out of a global directory that cannot be written, and
 * carry out the chosen one: install into the project instead, or move npm's
 * prefix somewhere writable and carry on with the global install (reporting
 * the bin directory that has to reach the user's PATH). Cancelling throws
 * InitCancelled.
 *
 * Runs with nobody to ask never reach the prompt: rewriting the user's npm
 * prefix and changing where argent gets installed are both decisions to make
 * with them, not while nobody is watching.
 */
type BlockedGlobalRecovery = { local: true } | { local: false; pathHint: string | null };

async function recoverBlockedGlobalInstall(opts: {
  target: GlobalInstallTarget;
  pm: PackageManager;
  nonInteractive: boolean;
  acknowledged: boolean;
  startedAt: number;
  tel: InitTelemetry;
}): Promise<BlockedGlobalRecovery> {
  const { target, pm, nonInteractive, acknowledged, startedAt, tel } = opts;

  const failWith = async (message: string): Promise<never> => {
    p.log.error(message);
    await tel.trackPackageAction(
      "fresh_install",
      startedAt,
      false,
      INSTALL_GLOBAL_PREFIX_UNWRITABLE
    );
    await tel.finalize(INSTALL_GLOBAL_PREFIX_UNWRITABLE);
    process.exit(1);
  };
  const failWithAdvice = (blocked: GlobalInstallTarget): Promise<never> =>
    failWith(unwritableGlobalTargetMessage(blocked, pm, "install"));

  // npm is the only manager whose global directory argent can relocate: the
  // equivalent knob differs for every other one, and yarn berry has no global
  // install at all.
  const canMovePrefix = pm === "npm";
  // A local install needs a package.json to add the devDependency to.
  const canInstallLocally = hasProjectPackageJson(resolveProjectRoot(process.cwd()));
  // Nobody to ask (init refuses a run with no terminal before reaching here,
  // so this is --yes), or nothing to offer them: spell the ways out as commands
  // instead of opening a prompt whose only option is to give up.
  if (nonInteractive || !(canMovePrefix || canInstallLocally)) return failWithAdvice(target);

  if (acknowledged) {
    // Chosen knowing the block, but for a manager whose directory argent
    // cannot relocate — there is nothing left to carry out.
    if (!canMovePrefix) return failWithAdvice(target);
  } else {
    p.log.warn(blockedGlobalTargetCause(target, pm, "install"));

    const options: Array<{ value: "local" | "prefix" | "cancel"; label: string; hint?: string }> =
      [];
    if (canInstallLocally) {
      options.push({
        value: "local",
        label: "Install into this project instead",
        hint: "a devDependency — no global directory needed",
      });
    }
    if (canMovePrefix) {
      options.push({
        value: "prefix",
        label: `Point npm at ${suggestedNpmPrefix()} and install there`,
        hint: "its bin directory has to be on your PATH",
      });
    }
    options.push({ value: "cancel", label: "Cancel" });

    const choice = await p.select({ message: "How would you like to proceed?", options });

    if (p.isCancel(choice) || choice === "cancel") {
      track("installation:global_install_decision", { decision: "cancel" });
      throw new InitCancelled("global_install");
    }

    if (choice === "local") {
      track("installation:global_install_decision", { decision: "install_local" });
      return { local: true };
    }
  }

  track("installation:global_install_decision", { decision: "set_prefix" });
  const prefix = suggestedNpmPrefix();
  const spinner = p.spinner();
  spinner.start(`Pointing npm at ${prefix}...`);
  try {
    await runShellCommand({ bin: "npm", args: ["config", "set", "prefix", prefix] });
  } catch (err) {
    // Reachable where this recovery exists: home-manager can own ~/.npmrc as a
    // read-only store symlink, leaving the project install as the way forward.
    spinner.stop(pc.red("Could not set the npm prefix."));
    await failWith(`${err}\n\n${localInstallRemedy()}`);
  }
  spinner.stop(`npm prefix set to ${prefix}.`);
  forgetInheritedNpmPrefix();

  // Confirm rather than assume: a prefix npm accepted but still cannot write to
  // would fail the install a step later, with npm's error instead of ours.
  // Repeating "point npm at a writable prefix" here would only send the user
  // back through the step that just ran.
  const moved = probeGlobalInstallTarget(pm);
  if (moved?.blocked) {
    await failWith(`${blockedGlobalTargetCause(moved, pm, "install")}\n\n${localInstallRemedy()}`);
  }

  const binDir = path.join(prefix, "bin");
  if ((process.env.PATH ?? "").split(path.delimiter).includes(binDir))
    return { local: false, pathHint: null };

  // Put it on PATH for the rest of THIS run so the install can be verified and
  // the configs written here name a binary that resolves. The user's own shells
  // still need the line — and argent does not add it for them: on the
  // Nix-managed machines this exists for, the shell profile is itself a
  // read-only store symlink.
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  p.log.warn(
    `Add ${pc.cyan(binDir)} to your PATH so new shells find ${PACKAGE_NAME}:\n` +
      `    ${pc.cyan(`export PATH="${binDir}:$PATH"`)}  ${pc.dim("(add to your shell profile)")}`
  );
  return { local: false, pathHint: binDir };
}

async function runGlobal(opts: {
  fromTar: string | null;
  nonInteractive: boolean;
  version: string;
  globalTarget: GlobalInstallTarget | null;
  globalBlockAcknowledged: boolean;
  tel: InitTelemetry;
}): Promise<InstallOutcome> {
  const { fromTar, nonInteractive, globalTarget, globalBlockAcknowledged, tel } = opts;
  let version = opts.version;
  let pathHint: string | null = null;
  const globallyInstalled = isGloballyInstalled();

  if (!globallyInstalled) {
    // Nowhere to install to: the manager's global directory cannot be written
    // (a Nix-managed toolchain puts it in the immutable store). Both ways out
    // are things init can carry out, so ask rather than stop here.
    const pm = detectPackageManager();
    const preflightStartedAt = performance.now();
    if (globalTarget?.blocked) {
      const recovery = await recoverBlockedGlobalInstall({
        target: globalTarget,
        pm,
        nonInteractive,
        acknowledged: globalBlockAcknowledged,
        startedAt: preflightStartedAt,
        tel,
      });
      if (recovery.local) {
        await installLocally({ fromTar, tel });
        return { version: localVersion(version), installMode: "local", pathHint: null };
      }
      // The prefix now points somewhere writable — fall through and install.
      pathHint = recovery.pathHint;
    }

    // No consent prompt here: the install-mode step directly above is where
    // the user chose "Globally" (or passed --global), and that choice IS the
    // consent to install the missing package — a second "install it?" select
    // reads as the same question asked twice.
    p.log.info(`Argent is not installed globally — installing.`);
    track("installation:global_install_decision", { decision: "install" });

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
    return { version, installMode: "global", pathHint };
  }

  if (fromTar) {
    // Developer-only reinstall path; it is not a product install decision.
    const pm = detectPackageManager();
    // Replacing the existing install writes to the same unwritable directory a
    // fresh one would.
    const globalTarget = probeGlobalInstallTarget(pm, getGloballyInstalledPackageRoot());
    if (globalTarget?.blocked) {
      p.log.error(unwritableGlobalTargetMessage(globalTarget, pm, "install"));
      await tel.finalize(INSTALL_GLOBAL_PREFIX_UNWRITABLE);
      process.exit(1);
    }
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
    return { version, installMode: "global", pathHint };
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
    const updatePm = detectPackageManager();
    // Probed only on the branch that would run the install — a --yes run skips
    // the update outright and must not pay for the package manager's query.
    const globalTarget = nonInteractive
      ? null
      : probeGlobalInstallTarget(updatePm, getGloballyInstalledPackageRoot());
    if (nonInteractive) {
      // A --yes/CI install implicitly skips the update; emit the same
      // update_decision as the other branches so the upgrade funnel isn't blind.
      track("installation:update_decision", {
        from_major: fromMajor,
        to_major: toMajor,
        decision: "skip",
      });
      await tel.trackPackageAction("update_skipped", packageActionStartedAt, true);
    } else if (globalTarget?.blocked) {
      // Offering an update argent cannot perform asks a question whose "yes"
      // only produces an EACCES dump. init's real work still succeeds against
      // the installed version, so this warns rather than aborting.
      p.log.warn(unwritableGlobalTargetMessage(globalTarget, updatePm, "update"));
      track("installation:update_decision", {
        from_major: fromMajor,
        to_major: toMajor,
        decision: "skip",
      });
      await tel.trackPackageAction(
        "update_failed",
        packageActionStartedAt,
        false,
        INSTALL_GLOBAL_PREFIX_UNWRITABLE
      );
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
        const cmd = globalInstallCommand(updatePm, `${PACKAGE_NAME}@${latest}`);
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

  return { version, installMode: "global", pathHint };
}
