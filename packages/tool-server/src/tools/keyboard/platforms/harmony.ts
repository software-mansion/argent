import { FAILURE_CODES } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { harmonyConnectKey } from "../../../utils/device-info";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  assertHarmonyDisplayReady,
  harmonyDisplay,
  harmonyKeyEvent,
  harmonyTypeText,
} from "../../../utils/harmony-uitest";
import type { KeyboardParams, KeyboardResult } from "../types";

/**
 * `uitest uiInput text` validates almost nothing (see `harmony-uitest.ts`) and
 * answers `No Error` whether or not anything landed, so an un-typeable
 * character is a silent wrong field while `keys` reports the count asked for.
 * Every sibling backend rejects such input up front with a 400
 * (`assertTypeableAndroidText`, `injectVegaText`, the iOS/chromium keycode
 * tables) — this is the harmony half of that contract. A newline gets its own
 * message pointing at `key: "enter"`, the same advice Android gives.
 */
function assertTypeableHarmonyText(text: string): void {
  if (/[\n\r]/.test(text)) {
    throw new InvalidToolInputError(
      'HarmonyOS `uitest uiInput text` cannot type a newline. Submit with `key: "enter"` after typing instead.',
      {
        error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
        failure_stage: "harmony_keyboard_validate_text",
        error_kind: "unsupported",
      }
    );
  }
  const bad = [...text].find((c) => {
    const cp = c.codePointAt(0)!;
    return cp < 0x20 || cp === 0x7f;
  });
  if (bad !== undefined) {
    throw new InvalidToolInputError(
      `HarmonyOS \`uitest uiInput text\` cannot type U+${bad.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} (a control character).`,
      {
        error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
        failure_stage: "harmony_keyboard_validate_text",
        error_kind: "unsupported",
      }
    );
  }
}

/**
 * Named keys this backend will press, and the `uitest uiInput keyEvent` keyID
 * each maps to.
 *
 * Every entry was confirmed against a physical HarmonyOS 6.0.1 handset by
 * typing into a real text field and reading the value back out of the layout
 * dump: `backspace` turned `abc` into `ab`; `space` turned `ab` into `ab `;
 * `arrow-left` then `X` produced `abX `, and `arrow-right` then `Y` produced
 * `abX Y`, which pins both directions; `enter` submitted the search and
 * replaced the screen.
 *
 * `return` and `delete` are the same two presses under the names the other
 * backends also take (`NAMED_KEYS`, `ANDROID_NAMED_KEYCODES`): a named key means
 * the same thing on every platform, so a step written against iOS or Android
 * must not be refused here for spelling `enter` the other way. `delete` aliases
 * backspace rather than forward-delete, for the reason spelled out beside the
 * Android table.
 *
 * `tab`, `escape` and the vertical arrows are deliberately absent. `uitest`
 * accepts their documented keycodes and reports `No Error`, but nothing
 * observable happened in a text field, so there is no evidence they do the
 * right thing — and a key that silently does nothing while the tool reports
 * `{ keys: 1 }` is worse than one that is refused. They belong here the moment
 * someone can watch them work.
 */
const HARMONY_KEYCODES: Record<string, number> = {
  "enter": 2054,
  "return": 2054,
  "backspace": 2055,
  "delete": 2055,
  "space": 2050,
  "arrow-left": 2014,
  "arrow-right": 2015,
};

function resolveHarmonyKeycode(key: string): number {
  const lower = key.toLowerCase();
  // Own-property check, and case-folded for parity with the other named-key
  // backends: `key` is a free string, so a prototype key like "constructor"
  // would otherwise pass the nullish guard with a garbage value and be
  // interpolated into the remote shell line (`harmonyKeyEvent` builds
  // `uiInput keyEvent ${key}`) instead of rejecting as an unknown key.
  const code = Object.hasOwn(HARMONY_KEYCODES, lower) ? HARMONY_KEYCODES[lower] : undefined;
  if (code === undefined) {
    throw new InvalidToolInputError(
      `Key '${key}' is not available on HarmonyOS. Supported: ` +
        `${Object.keys(HARMONY_KEYCODES).join(", ")}.`,
      {
        error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
        failure_stage: "harmony_keyboard_resolve_key",
        error_kind: "unsupported",
      }
    );
  }
  return code;
}

async function typeHarmony(connectKey: string, params: KeyboardParams): Promise<KeyboardResult> {
  // The tool rejects a request carrying both `text` and `key` (see ../index.ts),
  // so at most one of the two injection branches below runs.
  //
  // Both checks are pure and both precede the first device round trip: an
  // unsupported key or an un-typeable character is the caller's mistake, and
  // asking the device first lets an unreachable one rewrite that 400 into a
  // connection error about a key that will never be supported.
  const keycode = params.key ? resolveHarmonyKeycode(params.key) : null;
  if (params.text) assertTypeableHarmonyText(params.text);
  // Neither key nor text is schema-valid (both are optional, with no refinement)
  // and injects nothing, so it costs no device round trip — the contract every
  // sibling backend follows. Reaching the device first would let a suspended
  // panel fail a step that was never going to type anything.
  if (keycode === null && !params.text) return { typed: "", keys: 0 };
  // One deadline for the display read and the injection it feeds, so the pair
  // stays under the MCP layer's abort-and-replay cap.
  const deadline = Date.now() + HARMONY_INTERACTION_TIMEOUT_MS;
  // Typing into a panel that is suspended, or that the render service could not
  // size, reports `No Error` and lands nowhere, so a dead screen fails the same
  // way a tap does.
  assertHarmonyDisplayReady(await harmonyDisplay(connectKey), "type");
  let keysPressed = 0;
  if (params.text) {
    // `uitest uiInput text` types into whatever holds focus, in one shot — there
    // is no per-character injection, so `delayMs` has nothing to pace (the tool
    // description already lists the platforms that ignore it).
    await harmonyTypeText(connectKey, params.text, deadline - Date.now());
    keysPressed += [...params.text].length;
  }
  if (keycode !== null) {
    await harmonyKeyEvent(connectKey, String(keycode), deadline - Date.now());
    keysPressed++;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

/**
 * HarmonyOS has no simulator-server controller; typing goes to the device's own
 * `uitest`, reached over `hdc`. Declaring the dependency here lets
 * `dispatchByPlatform` preflight it and return a clean 424 install hint.
 */
export const harmonyImpl: PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> = {
  requires: ["hdc"],
  handler: (_services, params, device) => typeHarmony(harmonyConnectKey(device.id), params),
};
