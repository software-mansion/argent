import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { runAdb, shellQuote } from "../../../utils/adb";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";
import { httpDeepLinkNote } from "../deep-link-note";

// `am start` failure shapes don't share an `Error:` prefix.
const AM_START_FAILURE =
  /Error:|No Activity found|Permission Denial|SecurityException|requires permission|denied/i;

/**
 * Without `-W`, `am start` reports a failure on stderr and still exits 0. Its
 * stdout `Starting: Intent { ... }` echo carries the URL, so it is skipped: a
 * URL containing "denied" would otherwise read as a failure.
 */
function amStartFailure(stdout: string, stderr: string): string | null {
  const verdict = `${stdout}\n${stderr}`
    .split("\n")
    .filter((line) => !line.startsWith("Starting: "))
    .join("\n")
    .trim();
  return AM_START_FAILURE.test(verdict) ? verdict : null;
}

export const androidImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    // `adb shell` re-parses the command in the device's shell, where `&`, `?`,
    // `#` and whitespace are metachars.
    const { stdout, stderr } = await runAdb(
      [
        "-s",
        params.udid,
        "shell",
        `am start -a android.intent.action.VIEW -d ${shellQuote(params.url)}`,
      ],
      { timeoutMs: 15_000 }
    );
    const failure = amStartFailure(stdout, stderr);
    if (failure !== null) {
      throw new FailureError(`open-url failed: ${failure}`, {
        error_code: FAILURE_CODES.ANDROID_OPEN_URL_FAILED,
        failure_stage: "android_open_url_am_start",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }
    return { opened: true, url: params.url, note: httpDeepLinkNote(params.url) };
  },
};
