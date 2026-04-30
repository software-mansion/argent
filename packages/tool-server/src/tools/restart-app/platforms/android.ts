import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { RestartAppParams, RestartAppResult } from "./ios";

export const androidImpl: PlatformImpl<unknown, RestartAppParams, RestartAppResult> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "restart-app",
      platform: "android",
      hint:
        "Use `adb shell am force-stop <pkg>` then `adb shell am start -W -n " +
        "<pkg>/<.Activity>`. Resolve the launcher activity via " +
        "`cmd package resolve-activity --brief <pkg>` when none is provided.",
    });
  },
};
