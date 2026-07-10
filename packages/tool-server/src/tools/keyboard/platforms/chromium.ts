import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { CHROMIUM_NAMED_KEYS, charToChromiumKey } from "../chromium-keys";
import type { KeyboardParams, KeyboardResult } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runChromium(api: ChromiumCdpApi, params: KeyboardParams): Promise<KeyboardResult> {
  const delay = params.delayMs ?? 50;
  let keysPressed = 0;

  if (params.key) {
    const named = CHROMIUM_NAMED_KEYS[params.key.toLowerCase()];
    if (!named) {
      throw new FailureError(
        `Unknown key "${params.key}". Supported: ${Object.keys(CHROMIUM_NAMED_KEYS).join(", ")}`,
        {
          error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
          failure_stage: "keyboard_named_key_chromium",
          failure_area: "tool_server",
          error_kind: "unsupported",
        }
      );
    }
    await api.dispatchKeyEvent({
      type: "keyDown",
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
    });
    await sleep(delay);
    await api.dispatchKeyEvent({
      type: "keyUp",
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
    });
    keysPressed++;
  }

  if (params.text) {
    for (const char of params.text) {
      const desc = charToChromiumKey(char);
      if (!desc) {
        throw new FailureError(`No CDP key descriptor for character "${char}"`, {
          error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
          failure_stage: "keyboard_char_chromium",
          failure_area: "tool_server",
          error_kind: "unsupported",
        });
      }
      await api.dispatchKeyEvent({
        type: "keyDown",
        key: desc.key,
        code: desc.code,
        windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
      });
      // `char` delivers the actual codepoint to the focused input; without
      // this the field receives no value.
      await api.dispatchKeyEvent({ type: "char", text: desc.text });
      await api.dispatchKeyEvent({
        type: "keyUp",
        key: desc.key,
        code: desc.code,
        windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
      });
      keysPressed++;
      await sleep(delay);
    }
  }

  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

export function makeChromiumImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device) => {
      const ref = chromiumCdpRef(device);
      const chromium = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
      return runChromium(chromium, params);
    },
  };
}
