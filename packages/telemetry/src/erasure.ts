import * as fs from "node:fs";
import { deleteAnonId } from "./identity.js";
import { writeConsentFlag } from "./consent.js";
import { configFilePath } from "./paths.js";
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

// Local-only reset: optionally persist opt-out, then delete the anonymous id.
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

  if (disableConsent) {
    // Preserve config unless the write left an empty object behind.
    try {
      const raw = fs.readFileSync(configFilePath(), "utf8");
      const json = JSON.parse(raw) as Record<string, unknown>;
      if (json && typeof json === "object" && Object.keys(json).length === 0) {
        fs.unlinkSync(configFilePath());
      }
    } catch {
      /* leave config in whatever state it ended up in */
    }
  }

  return { localIdRemoved, consentDisabled };
}
