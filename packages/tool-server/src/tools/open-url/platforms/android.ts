import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell } from "../../../utils/adb";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";
import { httpDeepLinkNote } from "../deep-link-note";

export const androidImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    // `adb shell` re-parses the command in the device's shell, where `&`, `?`,
    // `#` and whitespace are metachars.
    const quoted = `'${params.url.replace(/'/g, "'\\''")}'`;
    const out = await adbShell(params.udid, `am start -a android.intent.action.VIEW -d ${quoted}`, {
      timeoutMs: 15_000,
    });
    // `am start` reports failures via several shapes that don't share an
    // `Error:` prefix.
    if (
      /Error:|No Activity found|Permission Denial|SecurityException|requires permission|denied/i.test(
        out
      )
    ) {
      throw new FailureError(`open-url failed: ${out.trim()}`, {
        error_code: FAILURE_CODES.ANDROID_OPEN_URL_FAILED,
        failure_stage: "android_open_url_am_start",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }
    return { opened: true, url: params.url, note: httpDeepLinkNote(params.url) };
  },
};
