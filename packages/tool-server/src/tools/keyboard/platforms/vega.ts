import type { DeviceInfo } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../../utils/capability";
import { injectVegaNamedKey, injectVegaText } from "../../../utils/vega-input";
import type { KeyboardParams, KeyboardResult } from "../types";

// Input is injected over `adb` (on-device `inputd-cli`). `requires: ["adb"]` is
// preflighted by dispatchByPlatform before the handler runs, so a missing adb
// fails with a 424 install hint rather than a spawn ENOENT.
async function runVega(device: DeviceInfo, params: KeyboardParams): Promise<KeyboardResult> {
  if (params.clear) {
    throw new UnsupportedOperationError(
      "keyboard",
      device,
      "clearing a field with `clear: true` is not supported on Vega"
    );
  }
  let keysPressed = 0;
  // ../index.ts rejects a request carrying both `text` and `key`, so at most one
  // of these two branches runs.
  if (params.text) {
    await injectVegaText(params.text);
    keysPressed += [...params.text].length;
  }
  if (params.key) {
    const count = params.repeat ?? 1;
    for (let i = 0; i < count; i++) {
      await injectVegaNamedKey(params.key);
      keysPressed++;
    }
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

export const vegaImpl: PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> = {
  requires: ["adb"],
  handler: (_services, params, device) => runVega(device, params),
};
