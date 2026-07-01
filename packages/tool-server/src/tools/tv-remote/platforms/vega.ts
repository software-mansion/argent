import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { injectVegaButtons } from "../../../utils/vega-input";
import { expandButtons, type TvRemoteParams, type TvRemoteResult } from "../types";

// Vega (Fire TV). Injects the whole button path in one `adb shell inputd-cli`
// round-trip — the full Vega remote vocabulary (media transport / volume / mute
// included) is supported here, unlike the focus-engine subset on Apple/Android
// TV. The `adb` dependency is preflighted by dispatchByPlatform before this runs.
export const vegaImpl: PlatformImpl<Record<string, unknown>, TvRemoteParams, TvRemoteResult> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const buttons = expandButtons(params.button, params.repeat);
    await injectVegaButtons(buttons);
    return { pressed: buttons, count: buttons.length };
  },
};
