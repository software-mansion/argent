import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { injectVegaNamedKey, injectVegaText } from "../../../utils/vega-input";
import type { KeyboardParams, KeyboardResult } from "../types";

// Vega has no simulator-server: input is injected over `adb` (on-device
// `inputd-cli`). The `adb` dependency is declared on this branch's `requires`
// and preflighted by dispatchByPlatform before the handler runs, so a missing
// adb fails with a clean 424 install hint rather than a spawn ENOENT.
async function runVega(params: KeyboardParams): Promise<KeyboardResult> {
  let keysPressed = 0;
  if (params.key) {
    await injectVegaNamedKey(params.key);
    keysPressed++;
  }
  if (params.text) {
    await injectVegaText(params.text);
    keysPressed += [...params.text].length;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

export const vegaImpl: PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> = {
  requires: ["adb"],
  handler: (_services, params) => runVega(params),
};
