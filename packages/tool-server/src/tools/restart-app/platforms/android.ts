import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, shellQuote, isAndroidTv } from "../../../utils/adb";
import {
  assertAmStartLaunched,
  normalizeActivityComponent,
  resolveLauncherActivity,
} from "../../launch-app/platforms/android";
import type { RestartAppParams, RestartAppResult } from "../types";

export const androidImpl: PlatformImpl<
  Record<string, unknown>,
  RestartAppParams,
  RestartAppResult
> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, bundleId, activity } = params;
    await adbShell(udid, `am force-stop ${shellQuote(bundleId)}`, { timeoutMs: 15_000 });
    // Match launch-app's relaunch path: `monkey` returns as soon as the intent
    // is injected and its /No activities found|Error:/ scrape false-failed on
    // legitimate class names like `com.example.ErrorReportingActivity`. Use
    // `am start -W -n <component>` with the same launch assertion launch-app
    // uses, so both tools agree on what counts as a successful start.
    let component: string;
    if (activity) {
      // Shared with launch-app so a bare class name ("MainActivity") becomes a
      // relative `${pkg}/.MainActivity` rather than the `${pkg}/MainActivity`
      // that `am start` rejects — the two tools must agree on this.
      component = normalizeActivityComponent(bundleId, activity);
    } else {
      const isTv = await isAndroidTv(udid);
      component = await resolveLauncherActivity(udid, bundleId, isTv);
    }
    const out = await adbShell(udid, `am start -W -n ${shellQuote(component)}`, {
      timeoutMs: 30_000,
    });
    let note: string | undefined;
    try {
      // `await` inside the try is load-bearing: without it the rejection would
      // escape this handler entirely and a failed relaunch would return
      // `restarted: true`.
      note = await assertAmStartLaunched(udid, component, out);
    } catch (err) {
      throw new FailureError(
        `relaunch failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          error_code: FAILURE_CODES.ANDROID_RESTART_FAILED,
          failure_stage: "android_restart_am_start",
          failure_area: "tool_server",
          error_kind: "subprocess",
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { restarted: true, bundleId, ...(note ? { note } : {}) };
  },
};
