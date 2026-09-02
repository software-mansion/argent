import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { injectVegaClear, injectVegaNamedKey, injectVegaText } from "../../../utils/vega-input";
import { CLEAR_KEY_PAIRS } from "../key-codes";
import type { KeyboardParams, KeyboardResult } from "../types";

// Input is injected over `adb` (on-device `inputd-cli`) for every shape this
// backend serves — text, a named key and the clear burst alike — so `adb` is
// declared as a dependency below and `dispatchByPlatform` preflights it, turning
// a missing binary into a 424 install hint instead of a spawn ENOENT.
async function runVega(params: KeyboardParams, signal?: AbortSignal): Promise<KeyboardResult> {
  if (params.clear === true) {
    // `keys` counts what was SENT, as on the other key-injecting backends: the
    // field is never read back, so the result says nothing about what it now
    // holds. On Vega those presses are all backspaces — see `injectVegaClear`
    // for why there is no forward half to send.
    await injectVegaClear(signal);
    return { typed: "", keys: CLEAR_KEY_PAIRS * 2, cleared: true };
  }
  let keysPressed = 0;
  // ../index.ts rejects a request carrying more than one of `text` / `key` /
  // `clear`, so at most one of these two branches runs.
  if (params.text) {
    await injectVegaText(params.text);
    keysPressed += [...params.text].length;
  }
  if (params.key) {
    await injectVegaNamedKey(params.key);
    keysPressed++;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

export const vegaImpl: PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> = {
  requires: ["adb"],
  handler: (_services, params, _device, options) => runVega(params, options?.signal),
};
