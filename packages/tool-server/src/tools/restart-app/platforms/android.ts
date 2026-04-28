import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { RestartAppParams, RestartAppResult } from "./ios";

export async function restartAppAndroid(
  _services: unknown,
  _params: RestartAppParams
): Promise<RestartAppResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "restart-app",
    platform: "android",
    hint:
      "Use `adb shell am force-stop <pkg>` then `adb shell am start -W -n " +
      "<pkg>/<.Activity>`. Resolve the launcher activity via " +
      "`cmd package resolve-activity --brief <pkg>` when none is provided.",
  });
}
