import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { LaunchAppParams, LaunchAppResult } from "./ios";

export async function launchAppAndroid(
  _services: unknown,
  _params: LaunchAppParams
): Promise<LaunchAppResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "launch-app",
    platform: "android",
    hint:
      "Use `adb shell am start -W -n <pkg>/<.Activity>`. Resolve the launcher " +
      "activity via `cmd package resolve-activity --brief <pkg>` if not provided. " +
      "Also make `launch-app/index.ts` services() platform-aware — Android does " +
      "not need the iOS native-devtools service.",
  });
}
