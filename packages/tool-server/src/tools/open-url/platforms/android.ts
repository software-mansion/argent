import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell } from "../../../utils/adb";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";

export const androidImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    // Single-quote the URL so `adb shell` doesn't reinterpret characters like
    // `&`, `?`, `#` or whitespace as shell metachars on the device side.
    const quoted = `'${params.url.replace(/'/g, "'\\''")}'`;
    const out = await adbShell(params.udid, `am start -a android.intent.action.VIEW -d ${quoted}`, {
      timeoutMs: 15_000,
    });
    if (/Error:|No Activity found/i.test(out)) {
      throw new Error(`open-url failed: ${out.trim()}`);
    }
    return { opened: true, url: params.url };
  },
};
