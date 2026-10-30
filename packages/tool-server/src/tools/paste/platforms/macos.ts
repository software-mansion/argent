import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { macosInsertText, resolveMacosApp } from "../../../utils/macos-input";
import type { PasteDispatchParams, PasteResult } from "../types";

/**
 * Mac app: the text is inserted at the focused element, as one paste would
 * insert it. The pasteboard is never touched: the app shares it with the host,
 * so filling it would overwrite what the user copied, and a secret would land
 * on the user's own clipboard.
 */
export function makeMacosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, PasteDispatchParams, PasteResult> {
  return {
    async handler(_services, params, device) {
      const app = await resolveMacosApp(registry, device, "paste");
      await macosInsertText(app, params.text);
      return { pasted: true };
    },
  };
}
