// First-run telemetry notice. Shown once per installation — to fresh installs
// (via `argent init`) and to users who update into a telemetry-enabled version
// (via the next `argent init` / `argent update` / `argent mcp` the new binary
// runs). The "already shown" marker lives in ~/.argent/config.json and is
// cleared on uninstall (see resetFirstRunNotice), so a later reinstall shows it
// again rather than staying silently suppressed.

import { readConfigObject, updateConfig } from "@argent/configuration-core";
import { isEnabled } from "./consent.js";

/** The command users run to opt out — callers may highlight it on their surface. */
export const TELEMETRY_OPT_OUT_COMMAND = "argent telemetry disable";

/** Link to the full privacy notice. */
export const TELEMETRY_DETAILS_URL = "https://swmansion.com/legal/argent/privacy-notice/";

/**
 * The descriptive body, one entry per rendered line. The opt-out command and
 * details URL are kept separate so each surface can style the command/link to
 * match its own conventions (e.g. cyan in the installer TUI).
 */
export const FIRST_RUN_NOTICE_BODY_LINES: readonly string[] = [
  "Argent collects anonymous usage data to help us improve the tool. We never",
  "collect your source code, file paths, tool inputs, or error contents.",
];

/** The whole notice as a plain string, for surfaces without a renderer (mcp stderr). */
export const FIRST_RUN_NOTICE = [
  ...FIRST_RUN_NOTICE_BODY_LINES,
  `Opt out anytime: ${TELEMETRY_OPT_OUT_COMMAND}`,
  `Details: ${TELEMETRY_DETAILS_URL}`,
].join("\n");

/** Whether the first-run notice has already been shown for this installation. */
export function hasShownFirstRunNotice(): boolean {
  const notices = readConfigObject().notices;
  if (notices && typeof notices === "object") {
    return (notices as Record<string, unknown>).first_run_shown === true;
  }
  return false;
}

/** Persist the "notice shown" marker, preserving other config keys. */
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
 * Clear the "notice shown" marker so the next install surfaces the notice again.
 * Called from the uninstall reset path. No-op when nothing is recorded, so it
 * never creates an empty config file just to delete a key. Telemetry consent is
 * intentionally left untouched — a persisted opt-out must survive a reinstall.
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
 * True when the notice should be rendered now: telemetry is active and the
 * notice has not been shown yet for this installation. When telemetry is
 * disabled (env or config) we skip the notice and do NOT mark it shown, so it
 * still appears once if the user later opts back in.
 */
export function shouldShowFirstRunNotice(): boolean {
  return isEnabled() && !hasShownFirstRunNotice();
}
