// First-run telemetry notice, shown once per installation by `argent init`,
// `argent update` and `argent mcp` — so updating into a telemetry-enabled
// version still surfaces it. The marker lives in the shared ~/.argent/config.json.

import { readConfigObject, updateConfig } from "@argent/configuration-core";
import { isEnabled } from "./consent.js";

export const TELEMETRY_OPT_OUT_COMMAND = "argent telemetry disable";

export const TELEMETRY_DETAILS_URL = "https://swmansion.com/legal/argent/privacy-notice/";

/**
 * One entry per rendered line. The opt-out command and details URL stay
 * separate so each surface can style them its own way (cyan in the installer).
 */
export const FIRST_RUN_NOTICE_BODY_LINES: readonly string[] = [
  "Argent collects usage data to help us improve the tool.",
  "We never collect your source code, file paths, tool inputs, or error contents.",
];

/** The whole notice as a plain string, for surfaces without a renderer (mcp stderr). */
export const FIRST_RUN_NOTICE = [
  ...FIRST_RUN_NOTICE_BODY_LINES,
  `Opt out anytime: ${TELEMETRY_OPT_OUT_COMMAND}`,
  `Details: ${TELEMETRY_DETAILS_URL}`,
].join("\n");

export function hasShownFirstRunNotice(): boolean {
  const notices = readConfigObject().notices;
  if (notices && typeof notices === "object") {
    return (notices as Record<string, unknown>).first_run_shown === true;
  }
  return false;
}

export function markFirstRunNoticeShown(): void {
  updateConfig((config) => {
    const noticesBlock =
      typeof config.notices === "object" && config.notices
        ? (config.notices as Record<string, unknown>)
        : {};
    config.notices = { ...noticesBlock, first_run_shown: true };
  });
}

/**
 * Clear the marker so the next install surfaces the notice again; called from
 * the uninstall reset. The early return avoids creating a config file just to
 * delete a key. Consent is left untouched — an opt-out must survive a reinstall.
 */
export function resetFirstRunNotice(): void {
  if (!hasShownFirstRunNotice()) return;
  updateConfig((config) => {
    const notices = config.notices;
    if (notices && typeof notices === "object") {
      delete (notices as Record<string, unknown>).first_run_shown;
    }
  });
}

/**
 * Disabled telemetry skips the notice without marking it shown, so it still
 * appears once if the user later opts back in.
 */
export function shouldShowFirstRunNotice(): boolean {
  return isEnabled() && !hasShownFirstRunNotice();
}
