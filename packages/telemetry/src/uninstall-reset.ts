import { deleteAnonId } from "./identity.js";
import { resetFirstRunNotice } from "./notice.js";
import { emitDebugError } from "./debug.js";

export interface TelemetryResetResult {
  /** True if the on-disk identity file was deleted (or was already gone). */
  localIdRemoved: boolean;
  /** True if the first-run-notice marker reset completed without error. */
  noticeReset: boolean;
}

// Uninstall leaves ~/.argent/config.json in place, so the first-run-notice marker
// must be cleared here or a reinstall would silently suppress the privacy notice.
//
// Not an identity erasure: the id is the host fingerprint when one resolves, so
// while consent stays enabled the next tracked event re-derives the identical id.
// A lasting opt-out is `markDisabled()` / `argent telemetry disable`, deliberately
// left untouched so it survives a reinstall.
//
// Errors are debug-only because uninstall must keep moving.
export async function resetLocalTelemetryState(): Promise<TelemetryResetResult> {
  let localIdRemoved = false;
  try {
    deleteAnonId();
    localIdRemoved = true;
  } catch (err) {
    emitDebugError("telemetry reset: deleting telemetry-id failed", err);
  }

  let noticeReset = false;
  try {
    resetFirstRunNotice();
    noticeReset = true;
  } catch (err) {
    emitDebugError("telemetry reset: resetting first-run notice failed", err);
  }

  return { localIdRemoved, noticeReset };
}
