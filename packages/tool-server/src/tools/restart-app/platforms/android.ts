import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, shellQuote, isAndroidTv, ensureMetroReverse } from "../../../utils/adb";
import {
  assertAmStartOk,
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
    // A restart is the usual recovery after a device reboot dropped the
    // reverse, so re-assert it while the app is down.
    await ensureMetroReverse(udid);
    await adbShell(udid, `am force-stop ${shellQuote(bundleId)}`, { timeoutMs: 15_000 });
    let component: string;
    if (activity) {
      component = normalizeActivityComponent(bundleId, activity);
    } else {
      const isTv = await isAndroidTv(udid);
      component = await resolveLauncherActivity(udid, bundleId, isTv);
    }
    const out = await adbShell(udid, `am start -W -n ${shellQuote(component)}`, {
      timeoutMs: 30_000,
    });
    try {
      assertAmStartOk(out);
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
    return { restarted: true, bundleId };
  },
};
