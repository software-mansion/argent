import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  shouldShowFirstRunNotice,
  hasShownFirstRunNotice,
  markFirstRunNoticeShown,
  getConsentState,
  writeConsentFlag,
  setSessionConsentOverride,
  FIRST_RUN_NOTICE_BODY_LINES,
  TELEMETRY_OPT_OUT_COMMAND,
  TELEMETRY_DETAILS_URL,
} from "@argent/telemetry";

const TELEMETRY_OPT_IN_COMMAND = "argent telemetry enable";

/** Print the telemetry notice, once per installation. */
export function printFirstRunNotice(): void {
  if (!shouldShowFirstRunNotice()) return;
  p.log.info(
    [
      pc.bold("Telemetry"),
      ...FIRST_RUN_NOTICE_BODY_LINES.map((line) => pc.dim(line)),
      `${pc.dim("Opt out anytime:")} ${pc.cyan(TELEMETRY_OPT_OUT_COMMAND)}`,
      `${pc.dim("Details:")} ${pc.dim(TELEMETRY_DETAILS_URL)}`,
    ].join("\n")
  );
  markFirstRunNoticeShown();
}

export type TelemetryConsentOutcome =
  | { kind: "enabled"; commit: () => void }
  | { kind: "disabled"; reason: "flag" }
  | { kind: "disabled"; reason: "choice"; commit: () => void }
  | { kind: "skipped" }
  | { kind: "cancelled" };

/**
 * Resolve telemetry consent before the first track() call, so the choice
 * governs whether this session's events are collected at all.
 *
 * Precedence:
 *  1. `--no-telemetry` — always disables, prompt or not.
 *  2. Non-interactive (`--yes`) — no TTY to prompt on; keep the default-on
 *     model and just surface the notice.
 *  3. An env override (DO_NOT_TRACK / ARGENT_TELEMETRY) already owns the
 *     decision and config can't override it.
 *  4. Already decided on a previous install — honor it.
 *  5. Interactive first run — ask, defaulting the selection to Enabled.
 *
 * A choice from case 5 takes effect for THIS session immediately, but is only
 * persisted — and the notice only marked shown — when the caller invokes the
 * returned `commit()`. Case 1 persists right away.
 */
export async function resolveTelemetryConsent(opts: {
  nonInteractive: boolean;
  disableFlag: boolean;
}): Promise<TelemetryConsentOutcome> {
  // 1. --no-telemetry wins in every mode.
  if (opts.disableFlag) {
    writeConsentFlag(false);
    markFirstRunNoticeShown();
    p.log.info(`${pc.bold("Telemetry")} ${pc.dim("disabled (--no-telemetry).")}`);
    return { kind: "disabled", reason: "flag" };
  }

  // 2. Non-interactive: keep the default, surface the notice only.
  if (opts.nonInteractive) {
    printFirstRunNotice();
    return { kind: "skipped" };
  }

  // 3/4. An env override owns the decision, or the user already chose.
  const source = getConsentState().source.source;
  const envOwnsDecision = source === "env_do_not_track" || source === "env_argent_telemetry";
  if (envOwnsDecision || hasShownFirstRunNotice()) {
    return { kind: "skipped" };
  }

  // 5. Interactive first run.
  p.log.info(
    [
      pc.bold("Telemetry"),
      ...FIRST_RUN_NOTICE_BODY_LINES.map((line) => pc.dim(line)),
      `${pc.dim("Opt out anytime:")} ${pc.cyan(TELEMETRY_OPT_OUT_COMMAND)}`,
      `${pc.dim("Details:")} ${pc.dim(TELEMETRY_DETAILS_URL)}`,
    ].join("\n")
  );

  const choice = await p.select({
    message: "Enable telemetry?",
    options: [
      { value: "enabled" as const, label: "Enabled", hint: "recommended" },
      { value: "disabled" as const, label: "Disabled" },
    ],
    initialValue: "enabled" as const,
  });

  if (p.isCancel(choice)) {
    // Caller cancels without tracking — the user agreed to nothing.
    return { kind: "cancelled" };
  }

  const enabled = choice === "enabled";
  // Effective this session right away; the durable write is deferred to
  // commit() so an aborted init re-asks next run.
  setSessionConsentOverride(enabled);
  const commit = (): void => {
    writeConsentFlag(enabled);
    markFirstRunNoticeShown();
  };

  if (enabled) {
    p.log.info(`${pc.bold("Telemetry")} ${pc.green("enabled")}.`);
    return { kind: "enabled", commit };
  }

  p.log.info(
    `${pc.bold("Telemetry")} ${pc.dim(`disabled. Enable anytime: ${TELEMETRY_OPT_IN_COMMAND}`)}`
  );
  return { kind: "disabled", reason: "choice", commit };
}
