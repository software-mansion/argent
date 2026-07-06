import { track } from "@argent/telemetry";
import { FAILURE_CODES, type FailureSignal } from "@argent/registry";
import { finalizeTelemetry } from "./telemetry-finalize.js";
import type { InstallMode } from "./install-record.js";

// Centralizes init's terminal-telemetry bookkeeping so the orchestrator and the
// step modules (notably install-runner) share one source of truth for the
// install-mode dimension, the editor count, and the finalize-once guard.

export type InstallerFailureSignal = FailureSignal & { failure_area: "installer" };

export const INSTALL_GLOBAL_PACKAGE_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_GLOBAL_PACKAGE_FAILED,
  failure_stage: "installer_global_package_install",
  failure_area: "installer",
  error_kind: "subprocess",
};

export const INSTALL_LOCAL_PACKAGE_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_LOCAL_PACKAGE_FAILED,
  failure_stage: "installer_local_package_install",
  failure_area: "installer",
  error_kind: "subprocess",
};

export const INSTALL_LOCAL_PRECONDITION_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_LOCAL_PRECONDITION_FAILED,
  failure_stage: "installer_local_precondition",
  failure_area: "installer",
  error_kind: "validation",
};

// `--local` and `--global` passed together — an argument-parse error, distinct
// from a failed local-install precondition. Kept separate so the local-install
// failure funnel isn't polluted with flag-usage mistakes (which never attempted
// an install and carry no meaningful install_mode).
export const INSTALL_MODE_FLAG_CONFLICT: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_MODE_FLAG_CONFLICT,
  failure_stage: "installer_install_mode_flag_conflict",
  failure_area: "installer",
  error_kind: "validation",
};

export const INSTALL_FROM_TAR_PACKAGE_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_FROM_TAR_PACKAGE_FAILED,
  failure_stage: "installer_from_tar_package_install",
  failure_area: "installer",
  error_kind: "subprocess",
};

export const INSTALL_INIT_TRIGGERED_UPDATE_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_INIT_TRIGGERED_UPDATE_FAILED,
  failure_stage: "installer_init_triggered_update",
  failure_area: "installer",
  error_kind: "subprocess",
};

// Catch-all for any unexpected throw that escapes the classified paths (file
// I/O, copyRulesAndAgents, the online check, a clack prompt). Without it the
// outer wrapper would drain telemetry but report no error code.
export const INSTALL_UNCLASSIFIED_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_UNCLASSIFIED_FAILED,
  failure_stage: "installer_init_unclassified",
  failure_area: "installer",
  error_kind: "unknown",
};

export type PackageActionName =
  | "fresh_install"
  | "already_installed"
  | "init_triggered_update"
  | "no_update"
  | "update_skipped"
  | "update_failed";

export class InitTelemetry {
  installMode: InstallMode = "global";
  editorsConfiguredCount = 0;
  initSucceeded = false;
  private finalized = false;

  constructor(private readonly startTime: number) {}

  // Drains buffered events and records the single terminal cli_init_complete.
  // Idempotent — only the first call emits.
  async finalize(failureSignal?: InstallerFailureSignal): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    await finalizeTelemetry(() => {
      track("installation:cli_init_complete", {
        duration_ms: performance.now() - this.startTime,
        is_success: this.initSucceeded,
        editors_configured_count: this.editorsConfiguredCount,
        install_mode: this.installMode,
        ...(failureSignal ?? {}),
      });
    });
  }

  async trackPackageAction(
    action: PackageActionName,
    startedAt: number,
    isSuccess: boolean,
    failureSignal?: InstallerFailureSignal
  ): Promise<void> {
    track("installation:package_action", {
      trigger: "init",
      action,
      is_success: isSuccess,
      duration_ms: performance.now() - startedAt,
      ...(failureSignal ?? {}),
    });
  }
}
