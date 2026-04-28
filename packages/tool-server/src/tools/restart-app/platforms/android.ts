import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell } from "../../../utils/adb";
import type { RestartAppParams, RestartAppResult, RestartAppServices } from "./ios";

export const androidImpl: PlatformImpl<RestartAppServices, RestartAppParams, RestartAppResult> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, bundleId } = params;
    await adbShell(udid, `am force-stop ${bundleId}`, { timeoutMs: 15_000 });
    const out = await adbShell(
      udid,
      `monkey -p ${bundleId} -c android.intent.category.LAUNCHER 1`,
      { timeoutMs: 30_000 }
    );
    if (/No activities found|Error:/i.test(out)) {
      throw new Error(`relaunch failed: ${out.trim()}`);
    }
    return { restarted: true, bundleId };
  },
};
