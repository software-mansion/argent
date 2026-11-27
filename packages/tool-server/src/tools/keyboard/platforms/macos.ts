import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { macosPressKey, macosTypeText, resolveMacosApp } from "../../../utils/macos-input";
import type { KeyboardParams, KeyboardResult } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mac app: the app can stay in the background. No character is refused: one
 * without a US key is inserted instead (`macosTypeText`). `key` also takes
 * modifiers (`command+a`).
 */
export function makeMacosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device) => {
      const app = await resolveMacosApp(registry, device, "keyboard");
      // ../index.ts rejects a request carrying both, so at most one runs.
      if (params.text) {
        const keys = await macosTypeText(app, params.text, { delayMs: params.delayMs });
        return { typed: params.text, keys };
      }
      if (params.key) {
        const count = params.repeat ?? 1;
        const delay = params.delayMs ?? 50;
        for (let i = 0; i < count; i++) {
          await macosPressKey(app, params.key);
          if (i < count - 1) await sleep(delay);
        }
        return { typed: params.key, keys: count };
      }
      return { typed: "", keys: 0 };
    },
  };
}
