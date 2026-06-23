import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { TvRemoteParams, TvRemoteResult } from "../types";
import { pressFocusRemote } from "./focus-remote";

// Android TV (leanback). Classifies as platform "android" by serial shape; the
// android-tv-control backend sends `adb input keyevent` D-pad codes. Delegates
// to the shared focus-driven remote (resolveTvApi rejects a non-leanback device).
export function makeAndroidImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, TvRemoteParams, TvRemoteResult> {
  return {
    requires: ["adb"],
    handler: (_services, params, device) => pressFocusRemote(registry, device, params),
  };
}
