import { adbShell } from "./adb";

export interface AndroidScreenSize {
  width: number;
  height: number;
}

const cache = new Map<string, { size: AndroidScreenSize; expiresAt: number }>();
// Short TTL so a rotation triggered externally invalidates the cache within a
// few seconds. Only the `describe` tool needs the absolute pixel size (to
// normalize uiautomator bounds to 0–1), so the cost of a cache miss is low.
const CACHE_TTL_MS = 5_000;

/**
 * Read the device's current logical screen size via `wm size`. Cached briefly
 * per serial. Used by `describe` to normalize uiautomator's absolute-pixel
 * bounds into the 0–1 coordinate space shared with the rest of the tools.
 *
 * `wm size` reports "Physical size: WxH\nOverride size: WxH"; the override
 * wins when present (set by emulators and some system configs).
 */
export async function getAndroidScreenSize(serial: string): Promise<AndroidScreenSize> {
  const cached = cache.get(serial);
  if (cached && cached.expiresAt > Date.now()) return cached.size;

  const out = await adbShell(serial, "wm size", { timeoutMs: 5_000 });
  const override = out.match(/Override size:\s*(\d+)x(\d+)/);
  const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
  const match = override ?? physical;
  if (!match) {
    throw new Error(`Could not parse screen size from: ${out.trim()}`);
  }
  const size: AndroidScreenSize = {
    width: parseInt(match[1]!, 10),
    height: parseInt(match[2]!, 10),
  };
  cache.set(serial, { size, expiresAt: Date.now() + CACHE_TTL_MS });
  return size;
}
