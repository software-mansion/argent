import { track } from "@argent/telemetry";
import { FAILURE_CODES, type FailureSignal } from "@argent/registry";
import { finalizeTelemetry } from "./telemetry-finalize.js";
import type { InstallMode } from "./install-record.js";

// Shared init telemetry context: the orchestrator and step modules (notably
// install-runner) reuse one install-mode dimension, editor count and finalize-once guard.

type InstallerFailureSignal = FailureSignal & { failure_area: "installer" };

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

// `--local` and `--global` together. Distinct from the local precondition
// failure so that funnel isn't polluted with flag misuse (no install attempted).
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

// Catch-all for throws escaping the classified paths; without it the terminal
// event would carry no error code.
export const INSTALL_UNCLASSIFIED_FAILED: InstallerFailureSignal = {
  error_code: FAILURE_CODES.INSTALL_UNCLASSIFIED_FAILED,
  failure_stage: "installer_init_unclassified",
  failure_area: "installer",
  error_kind: "unknown",
};

type PackageActionName =
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

  // Records the single terminal cli_init_complete, then drains the event queue.
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
    failureSignal?: InstallerFailureSignal,
    attemptInfo?: { retry_count: number; last_attempt_duration_ms: number }
  ): Promise<void> {
    track("installation:package_action", {
      trigger: "init",
      action,
      is_success: isSuccess,
      duration_ms: performance.now() - startedAt,
      ...(attemptInfo ?? {}),
      ...(failureSignal ?? {}),
    });
  }
}
