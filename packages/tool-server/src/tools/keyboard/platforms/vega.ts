import type { DeviceInfo } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../../utils/capability";
import { injectVegaNamedKey, injectVegaText } from "../../../utils/vega-input";
import type { KeyboardParams, KeyboardResult } from "../types";

// Vega has no simulator-server: input is injected over `adb` (on-device
// `inputd-cli`). The `adb` dependency is declared on this branch's `requires`
// and preflighted by dispatchByPlatform before the handler runs, so a missing
// adb fails with a clean 424 install hint rather than a spawn ENOENT.
async function runVega(device: DeviceInfo, params: KeyboardParams): Promise<KeyboardResult> {
  let keysPressed = 0;
  // Vega injects through `inputd-cli`, which exposes no modifier-combination
  // primitive, so the select-all chord the iOS/Chromium clears use cannot be
  // sent here. (The count-and-backspace shape the Android legacy path uses would
  // be expressible, but it needs a way to read the focused field's length, which
  // this transport has no equivalent of.) Reject explicitly rather than no-op: a
  // silent no-op on an unsupported input path is exactly the failure mode of
  // issue #449, which this tool has already shipped once. Checked BEFORE any
  // injection so an unsupported request leaves the device untouched.
  if (params.clear) {
    throw new UnsupportedOperationError(
      "keyboard",
      device,
      "`clear` is not supported on Vega — its `inputd-cli` transport cannot send the " +
        "select-all modifier chord. Delete the field's contents with repeated " +
        '`key: "backspace"` presses instead'
    );
  }
  // The tool rejects a request carrying both `text` and `key` (see ../index.ts),
  // so at most one of the two branches below runs.
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
  handler: (_services, params, device) => runVega(device, params),
};
