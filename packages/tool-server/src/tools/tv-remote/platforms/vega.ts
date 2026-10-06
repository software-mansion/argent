import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { injectVegaButtons } from "../../../utils/vega-input";
import { expandButtons, type TvRemoteParams, type TvRemoteResult } from "../types";

// Vega (Fire TV). The whole button path goes in one `adb shell inputd-cli`
// round-trip, unlike the press-per-round-trip focus-remote path.
export const vegaImpl: PlatformImpl<Record<string, unknown>, TvRemoteParams, TvRemoteResult> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const buttons = expandButtons(params.button, params.repeat);
    await injectVegaButtons(buttons);
    return { pressed: buttons, count: buttons.length };
  },
};
