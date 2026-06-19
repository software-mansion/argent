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

/** The command users run to turn telemetry back on after disabling it. */
const TELEMETRY_OPT_IN_COMMAND = "argent telemetry enable";

/**
 * Print the anonymous-telemetry notice, once per installation. Shared by
 * `argent update` and the non-interactive `argent init` path so both surfaces
 * render the same informational message; the marker is cleared on uninstall so
 * reinstalls show it again. The opt-out command is highlighted in cyan to match
 * how commands are styled elsewhere in the flow. No-op when telemetry is
 * disabled or already shown this installation.
 */
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
 * Resolve telemetry consent for `argent init`, BEFORE the first track() call so
 * the user's choice governs whether this session's installation events are
 * collected at all.
 *
 * Precedence:
 *  1. `--no-telemetry` — always disables, prompt or not.
 *  2. Non-interactive (`--yes`) — keep the default-on (opt-out) model and just
 *     surface the informational notice; there is no TTY to prompt on.
 *  3. An env override (DO_NOT_TRACK / ARGENT_TELEMETRY) already owns the
 *     decision and config can't override it, so don't prompt.
 *  4. Already decided on a previous install — honor it, don't re-ask.
 *  5. Interactive first run — ask, defaulting the selection to Enabled.
 *
 * An interactive choice (case 5) takes effect for THIS session immediately via
 * an in-process override, but is only persisted — and the notice only marked
 * shown — when the caller invokes the returned `commit()`. init defers that to
 * a completed install, so a user who picks a value then aborts setup is
 * re-prompted next run instead of silently inheriting the abandoned choice. The
 * `--no-telemetry` flag (case 1) is an explicit, durable opt-out and persists
 * right away.
 */
export async function resolveTelemetryConsent(opts: {
  nonInteractive: boolean;
  disableFlag: boolean;
}): Promise<TelemetryConsentOutcome> {
  // 1. Explicit --no-telemetry wins in every mode.
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

  // 3/4. Don't prompt when an env override owns the decision, or when the user
  // already chose on a previous install.
  const source = getConsentState().source.source;
  const envOwnsDecision = source === "env_do_not_track" || source === "env_argent_telemetry";
  if (envOwnsDecision || hasShownFirstRunNotice()) {
    return { kind: "skipped" };
  }

  // 5. Interactive first run: explain what we collect, then ask.
  p.log.info(
    [
      pc.bold("Telemetry"),
      ...FIRST_RUN_NOTICE_BODY_LINES.map((line) => pc.dim(line)),
      `${pc.dim("Opt out anytime:")} ${pc.cyan(TELEMETRY_OPT_OUT_COMMAND)}`,
      `${pc.dim("Details:")} ${pc.dim(TELEMETRY_DETAILS_URL)}`,
    ].join("\n")
  );

  const choice = await p.select({
    message: "Enable anonymous telemetry?",
    options: [
      { value: "enabled" as const, label: "Enabled", hint: "recommended" },
      { value: "disabled" as const, label: "Disabled" },
    ],
    initialValue: "enabled" as const,
  });

  if (p.isCancel(choice)) {
    // Caller cancels init without tracking — the user agreed to nothing.
    return { kind: "cancelled" };
  }

  const enabled = choice === "enabled";
  // Make the pick effective for this session right away, but defer the durable
  // write: committing only on a completed install means an aborted init re-asks
  // next run rather than remembering a choice the user backed out of.
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
