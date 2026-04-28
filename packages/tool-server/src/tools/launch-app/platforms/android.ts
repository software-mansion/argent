import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { LaunchAppParams, LaunchAppResult } from "./ios";

// Android launch path doesn't use the iOS native-devtools service; when the
// impl lands, also make `launch-app/index.ts` services() platform-aware so
// the Android branch resolves only the services it actually needs.
export const androidImpl: PlatformImpl<unknown, LaunchAppParams, LaunchAppResult> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "launch-app",
      platform: "android",
      hint:
        "Use `adb shell am start -W -n <pkg>/<.Activity>`. Resolve the launcher " +
        "activity via `cmd package resolve-activity --brief <pkg>` if not provided. " +
        "Also make `launch-app/index.ts` services() platform-aware — Android does " +
        "not need the iOS native-devtools service.",
    });
  },
};
