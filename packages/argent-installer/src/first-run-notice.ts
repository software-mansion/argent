import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  shouldShowFirstRunNotice,
  markFirstRunNoticeShown,
  FIRST_RUN_NOTICE_BODY_LINES,
  TELEMETRY_OPT_OUT_COMMAND,
  TELEMETRY_DETAILS_URL,
} from "@argent/telemetry";

/**
 * Print the anonymous-telemetry notice, once per installation. Shared by
 * `argent init` and `argent update` so both surfaces render the same message;
 * the marker is cleared on uninstall so reinstalls show it again. The opt-out
 * command is highlighted in cyan to match how commands are styled elsewhere in
 * the flow. No-op when telemetry is disabled or already shown this installation.
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
