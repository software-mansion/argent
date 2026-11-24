import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, shellQuote, isAndroidTv } from "../../../utils/adb";
import {
  assertAmStartOk,
  followNativeNetworkCapture,
  launcherStartArgs,
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
    let component: string;
    let category: string | null = null;
    if (activity) {
      component = normalizeActivityComponent(bundleId, activity);
    } else {
      const isTv = await isAndroidTv(udid);
      ({ component, category } = await resolveLauncherActivity(udid, bundleId, isTv));
    }
    const start = `am start -W${launcherStartArgs(category)} -n ${shellQuote(component)}`;
    const out = await adbShell(udid, start, {
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
    const capture = await followNativeNetworkCapture(udid, bundleId);
    return { restarted: true, bundleId, ...capture };
  },
};
