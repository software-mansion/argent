import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import {
  injectVegaNamedKey,
  injectVegaText,
  resolveVegaNamedKeycode,
} from "../../../utils/vega-input";
import type { KeyboardParams, KeyboardResult } from "../types";

// Vega has no simulator-server: input is injected over `adb` (on-device
// `inputd-cli`). The `adb` dependency is declared on this branch's `requires`
// and preflighted by dispatchByPlatform before the handler runs, so a missing
// adb fails with a clean 424 install hint rather than a spawn ENOENT.
async function runVega(params: KeyboardParams): Promise<KeyboardResult> {
  let keysPressed = 0;
  // Resolve the named key before injecting text so an unknown name fails fast.
  if (params.key) resolveVegaNamedKeycode(params.key);
  if (params.text) {
    await injectVegaText(params.text);
    keysPressed += [...params.text].length;
  }
  // Key after text: a combined call means "type, then submit" (text +
  // key:"enter"). Pressing the key first submits the still-empty field.
  if (params.key) {
    await injectVegaNamedKey(params.key);
    keysPressed++;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

export const vegaImpl: PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> = {
  requires: ["adb"],
  handler: (_services, params) => runVega(params),
};
