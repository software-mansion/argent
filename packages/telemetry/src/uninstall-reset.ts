import { deleteAnonId } from "./identity.js";
import { resetFirstRunNotice } from "./notice.js";
import { emitDebugError } from "./debug.js";

export interface TelemetryResetResult {
  /** True if the on-disk identity file was deleted (or was already gone). */
  localIdRemoved: boolean;
  /** True if the first-run-notice marker reset completed without error. */
  noticeReset: boolean;
}

// Local cleanup run on uninstall: delete the on-disk telemetry id and clear the
// first-run-notice marker so a later reinstall surfaces the privacy notice again
// (uninstall does not remove ~/.argent/config.json, so without this the marker
// would persist and silently suppress the notice on reinstall).
//
// This is NOT an identity erasure. The distinct_id IS the host fingerprint (a
// 64-hex one-way hash of stable hardware ids, used verbatim), so deleting the id
// file does not mint a fresh identity — while consent stays enabled the next
// tracked event re-derives the identical id. A genuine, lasting opt-out is `markDisabled()` /
// `argent telemetry disable`, which this deliberately leaves untouched so a
// persisted opt-out survives a reinstall.
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
