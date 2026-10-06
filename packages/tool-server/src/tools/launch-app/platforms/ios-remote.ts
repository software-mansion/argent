import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { remoteSimctl } from "../../../utils/simctl-backend";
import type { LaunchAppIosServices, LaunchAppParams, LaunchAppResult } from "../types";
import { buildIosLaunchHandler } from "./shared";

/** Routes through `sim-remote simctl launch` instead of `xcrun simctl launch`. */
export const iosRemoteImpl: PlatformImpl<LaunchAppIosServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["sim-remote"],
  handler: buildIosLaunchHandler(remoteSimctl),
};
