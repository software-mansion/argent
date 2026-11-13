import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { macosPressKey, macosTypeText, resolveMacosApp } from "../../../utils/macos-input";
import type { KeyboardParams, KeyboardResult } from "../types";

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
        await macosPressKey(app, params.key);
        return { typed: params.key, keys: 1 };
      }
      return { typed: "", keys: 0 };
    },
  };
}
