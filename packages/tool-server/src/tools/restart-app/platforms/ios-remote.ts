import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { remoteSimctl } from "../../../utils/simctl-backend";
import type { RestartAppIosServices, RestartAppParams, RestartAppResult } from "../types";
import { buildIosRestartHandler } from "./shared";

export const iosRemoteImpl: PlatformImpl<
  RestartAppIosServices,
  RestartAppParams,
  RestartAppResult
> = {
  requires: ["sim-remote"],
  handler: buildIosRestartHandler(remoteSimctl),
};
