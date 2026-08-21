import { FAILURE_CODES } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { injectVegaNamedKey, injectVegaText } from "../../../utils/vega-input";
import type { KeyboardParams, KeyboardResult } from "../types";

// Vega has no simulator-server: input is injected over `adb` (on-device
// `inputd-cli`). The `adb` dependency is declared on this branch's `requires`
// and preflighted by dispatchByPlatform before the handler runs, so a missing
// adb fails with a clean 424 install hint rather than a spawn ENOENT.
async function runVega(params: KeyboardParams): Promise<KeyboardResult> {
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
    // An `InvalidToolInputError`, not an `UnsupportedOperationError`: the tool
    // IS supported here — its own description and `argent-tv-interact` both send
    // the agent to `keyboard` to type on Vega — and one parameter of this
    // request is not. That class opens its message by saying the whole tool is
    // unsupported on the target, and hard-codes
    // TOOL_CAPABILITY_UNSUPPORTED_OPERATION as its signal, which files a refused
    // `clear` under the same code as a tool that cannot run here at all.
    // What to re-send depends on what else the request carries, the way the TV
    // twin (`platforms/tv.ts`) discriminates it. One blanket "send the same call
    // without `clear`" is wrong for the two shapes that carry nothing to type:
    // `{ clear: true }` alone — the empty-the-field call this parameter exists
    // for — and `{ clear: true, text: "" }`, which `if (params.text)` below
    // no-ops. Re-sending either does nothing at all, so the field ends up
    // neither emptied nor typed into. Unlike a TV, Vega does accept `key`, so a
    // `{ clear, key }` request has a real remainder to re-send.
    const next = params.text
      ? "Typing works: send the same call without `clear`."
      : params.key
        ? "The key press works: send the same call without `clear`."
        : "Nothing else in this request needs re-sending.";
    throw new InvalidToolInputError(
      "keyboard clear: `clear` is not supported on Vega — its `inputd-cli` transport cannot " +
        'send the select-all modifier chord. Empty the field with repeated `key: "backspace"` ' +
        `presses instead. ${next}`,
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_TARGET,
        failure_stage: "keyboard_clear_vega",
        error_kind: "unsupported",
      }
    );
  }
  // No resolve-before-inject hoist here, unlike the other three backends. It
  // buys nothing on this one: the tool rejects `{ text, key }` above the
  // dispatch (see ../index.ts), and the only other way a bad key name could
  // arrive after something destructive — `{ clear, key }` — is refused above.
  // So at most one of the two branches below runs, and it is the first thing
  // this backend does.
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
  handler: (_services, params) => runVega(params),
};
