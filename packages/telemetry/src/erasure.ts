import { deleteAnonId } from "./identity.js";
import { writeConsentFlag } from "./consent.js";
import { resetFirstRunNotice } from "./notice.js";
import { emitDebugError } from "./debug.js";

export interface ForgetOptions {
  /** Persist opt-out as part of the local reset. */
  disableConsent?: boolean;
}

export interface ForgetResult {
  /** True if the on-disk identity file was deleted (or already gone). */
  localIdRemoved: boolean;
  /** True if persisted consent flag was set to false. */
  consentDisabled: boolean;
}

// Local-only reset: optionally persist opt-out (default), then delete the
// on-disk anonymous id.
//
// Deleting the id file is a LOCAL id-file removal, not a permanent erasure of
// the machine's identity. Because the distinct_id is now derived deterministically
// from the host fingerprint, removing the file alone does NOT yield a fresh
// identity: while consent stays enabled the next tracked event re-derives the
// identical id. A genuine, lasting reset comes from the opt-out — with
// disableConsent (the default) persisted, track() short-circuits and the id is
// never re-created. Callers that want only the file gone (disableConsent: false)
// must expect it to re-derive on the next event.
//
// Errors are debug-only because forget/uninstall should keep moving.
export async function forget(options: ForgetOptions = {}): Promise<ForgetResult> {
  const disableConsent = options.disableConsent ?? true;

  let consentDisabled = false;
  if (disableConsent) {
    try {
      writeConsentFlag(false);
      consentDisabled = true;
    } catch (err) {
      emitDebugError("forget: writing consent flag failed", err);
    }
  }

  let localIdRemoved = false;
  try {
    deleteAnonId();
    localIdRemoved = true;
  } catch (err) {
    emitDebugError("forget: deleting telemetry-id failed", err);
  }

  // Clear the first-run-notice marker so a later reinstall surfaces the notice
  // again. Consent is handled above; this only resets the "already shown" state.
  try {
    resetFirstRunNotice();
  } catch (err) {
    emitDebugError("forget: resetting first-run notice failed", err);
  }

  return { localIdRemoved, consentDisabled };
}
