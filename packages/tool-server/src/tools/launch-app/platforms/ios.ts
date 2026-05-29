import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { localSimctl } from "../../../utils/simctl-backend";
import type { LaunchAppIosServices, LaunchAppParams, LaunchAppResult } from "../types";
import { buildIosLaunchHandler } from "./shared";

export const iosImpl: PlatformImpl<LaunchAppIosServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["xcrun"],
  handler: buildIosLaunchHandler(localSimctl),
};
