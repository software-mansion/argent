import { FAILURE_CODES } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { harmonyConnectKey } from "../../../utils/device-info";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  assertHarmonyDisplayReady,
  harmonyDisplay,
  holdUitestQueue,
  HARMONY_DISPLAY_TIMEOUT_MS,
  remainingBudget,
} from "../../../utils/harmony-uitest";
import type { KeyboardParams, KeyboardResult } from "../types";

/** `uitest` answers `No Error` for un-typeable text, so reject it up front as the other backends do. */
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
 * Keys verified by typing into a field on a handset and reading it back.
 * `return`/`delete` alias enter/backspace as on the other backends. `tab`,
 * `escape` and the vertical arrows answer `No Error` but did nothing observable,
 * so they are refused.
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
  // Own-property: a free string like "constructor" must not reach the shell line.
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

async function typeHarmony(
  connectKey: string,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  // Validate before any device round trip, so an unreachable device cannot
  // mask a 400.
  const keycode = params.key ? resolveHarmonyKeycode(params.key) : null;
  if (params.text) assertTypeableHarmonyText(params.text);
  if (keycode === null && !params.text) return { typed: "", keys: 0 };
  const deadline = Date.now() + HARMONY_INTERACTION_TIMEOUT_MS;
  // Prefilter that fails fast without queueing; the check trusted is inside the hold.
  assertHarmonyDisplayReady(await harmonyDisplay(connectKey), "type");
  let keysPressed = 0;
  await holdUitestQueue(
    connectKey,
    deadline,
    async (ui) => {
      assertHarmonyDisplayReady(
        await harmonyDisplay(
          connectKey,
          Math.min(
            HARMONY_DISPLAY_TIMEOUT_MS,
            remainingBudget(connectKey, deadline, "the display re-read")
          )
        ),
        "type"
      );
      if (params.text) {
        await ui.type(params.text);
        keysPressed += [...params.text].length;
      }
      if (keycode !== null) {
        await ui.keyEvent(String(keycode));
        keysPressed++;
      }
    },
    signal
  );
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

export const harmonyImpl: PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> = {
  requires: ["hdc"],
  handler: (_services, params, device, options) =>
    typeHarmony(harmonyConnectKey(device.id), params, options?.signal),
};
