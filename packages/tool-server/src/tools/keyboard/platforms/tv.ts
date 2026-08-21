import { FAILURE_CODES, type DeviceInfo, type Registry } from "@argent/registry";
import { InvalidToolInputError, UnsupportedOperationError } from "../../../utils/capability";
import { resolveTvApi } from "../../tv/tv-service";
import type { KeyboardParams, KeyboardResult } from "../types";

// TV typing goes through the focus-driven tv-control backend (injected HID
// keyboard on Apple TV, `adb input text` on Android TV). Named keys are
// navigation on a TV, which belongs to `tv-remote` — so they're rejected here.
// Shared by the ios (Apple TV) and android (Android TV) branches.
export async function typeTv(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
): Promise<KeyboardResult> {
  // `clear` is not implemented for either TV family, and the reason differs by
  // family — so the message states the outcome rather than a cause that would be
  // wrong for one of them. Apple TV genuinely cannot: its typing backend sends
  // whole strings through the focus daemon and has no modifier-chord primitive.
  // Android TV could — `androidTvControlBlueprint.type()` reaches the same
  // on-device `input` binary as the phone path, so `input keycombination` is
  // available to it — but routing a clear through it is unverified on a TV, and
  // half-supporting `clear` across the two families would be worse than not
  // supporting it. Reject rather than silently no-op (issue #449), up front so
  // nothing is typed before the rejection.
  if (params.clear) {
    // An `InvalidToolInputError`, not an `UnsupportedOperationError`: the tool
    // IS supported here — its own description and `argent-tv-interact` both send
    // the agent to `keyboard` to type into a focused field on a TV — and one
    // parameter of this request is not. That class opens its message by saying
    // the whole tool is unsupported on the target (and labels a tvOS device an
    // "ios simulator"), and hard-codes TOOL_CAPABILITY_UNSUPPORTED_OPERATION as
    // its signal, which files a refused `clear` under the same code as a tool
    // that cannot run here at all.
    // What to do next depends on what ELSE the request carries, because a TV
    // target does not accept `key` either: "send the same call without `clear`"
    // sent `{ clear: true, key: "enter" }` — the very shape the clear-before-key
    // ordering below was built for — straight into a second 400 from the `key`
    // refusal (verified live on tvOS 26.5). A clear-only call has nothing to
    // re-send at all.
    // Truthiness, not `!== undefined`: `{ clear: true, text: "" }` names `text`
    // but carries nothing to type, and `if (text)` below would no-op it — so the
    // re-send advice would send the caller to a second call that neither clears
    // nor types. It belongs in the same arm as a clear-only request, which is
    // the shape it actually is.
    const next = params.key
      ? "This request also carries `key`, which a TV target does not accept either — press it " +
        "with `tv-remote` (select/up/down/left/right) instead."
      : params.text
        ? "Typing works: send the same call without `clear`."
        : "Nothing else in this request needs re-sending.";
    throw new InvalidToolInputError(
      "keyboard clear: `clear` is not supported on a TV target — delete the existing value " +
        "with repeated backspaces on the on-screen keyboard, or use the field's own clear " +
        `affordance. ${next}`,
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_TARGET,
        failure_stage: "keyboard_clear_tv",
        error_kind: "unsupported",
      }
    );
  }
  // AFTER the clear, so a request that is invalid in both halves reports the
  // destructive one — and reports it the way this file went to the trouble of
  // wording. Checked first, `{ clear: true, key: "enter" }` came back as
  // TOOL_CAPABILITY_UNSUPPORTED_OPERATION / "Tool 'keyboard' is not supported on
  // ios simulator …": exactly the class the comment above rejects, on the exact
  // request `clear`'s own refusal exists for (verified live on tvOS 26.5).
  // `platforms/vega.ts` already takes the two in this order.
  if (params.key) {
    throw new UnsupportedOperationError(
      "keyboard",
      device,
      "named keys are not supported on a TV target — move focus with `tv-remote` " +
        "(up/down/left/right/select) instead"
    );
  }
  const text = params.text ?? "";
  if (text) {
    const api = await resolveTvApi(registry, device.id);
    await api.type(text);
  }
  // Count by codepoint (not UTF-16 units) so a non-BMP char reports `keys: 1`,
  // matching the vega and simulator-server keyboard backends.
  return { typed: text, keys: [...text].length };
}
