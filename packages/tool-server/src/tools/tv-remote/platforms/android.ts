import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { TvRemoteParams, TvRemoteResult } from "../types";
import { pressFocusRemote } from "./focus-remote";

// Android TV (leanback). No `unsupported` set — every remote button maps to a
// real `adb input keyevent`.
export function makeAndroidImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, TvRemoteParams, TvRemoteResult> {
  return {
    requires: ["adb"],
    handler: (_services, params, device, options) =>
      pressFocusRemote(registry, device, params, undefined, options),
  };
}
