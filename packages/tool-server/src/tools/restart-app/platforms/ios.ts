import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { localSimctl } from "../../../utils/simctl-backend";
import type { RestartAppIosServices, RestartAppParams, RestartAppResult } from "../types";
import { buildIosRestartHandler } from "./shared";

export const iosImpl: PlatformImpl<RestartAppIosServices, RestartAppParams, RestartAppResult> = {
  requires: ["xcrun"],
  handler: buildIosRestartHandler(localSimctl),
};
