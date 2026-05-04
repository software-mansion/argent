import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell } from "../../../utils/adb";
import {
  assertAmStartOk,
  resolveLauncherActivity,
} from "../../launch-app/platforms/android";
import type { RestartAppParams, RestartAppResult, RestartAppServices } from "../types";

export const androidImpl: PlatformImpl<RestartAppServices, RestartAppParams, RestartAppResult> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, bundleId, activity } = params;
    await adbShell(udid, `am force-stop ${bundleId}`, { timeoutMs: 15_000 });
    // Match launch-app's relaunch path: `monkey` returns as soon as the intent
    // is injected and its /No activities found|Error:/ scrape false-failed on
    // legitimate class names like `com.example.ErrorReportingActivity`. Use
    // `am start -W -n <component>` with the same `Status: ok` positive-match
    // assertion launch-app moved to.
    let component: string;
    if (activity) {
      component = activity.startsWith(".")
        ? `${bundleId}/${activity}`
        : activity.includes("/")
          ? activity
          : `${bundleId}/${activity}`;
    } else {
      component = await resolveLauncherActivity(udid, bundleId);
    }
    const out = await adbShell(udid, `am start -W -n ${component}`, { timeoutMs: 30_000 });
    try {
      assertAmStartOk(out);
    } catch (err) {
      throw new Error(`relaunch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { restarted: true, bundleId };
  },
};
