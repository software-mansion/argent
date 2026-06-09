import { adbShell } from "./adb";

export interface AndroidScreenSize {
  width: number;
  height: number;
}

/**
 * Read the device's current logical screen size via `wm size`. Used by
 * `describe` to normalize uiautomator's absolute-pixel bounds into the
 * 0–1 coordinate space shared with the rest of the tools.
 *
 * `wm size` reports "Physical size: WxH\nOverride size: WxH"; the override
 * wins when present (set by emulators and some system configs).
 *
 * NOT cached: a 5 s TTL would have served stale dimensions for several
 * describes after a rotation (rotation completes in <500 ms), producing
 * normalized frames with x>1 / width>1 because the screenW used for the
 * divisor was pre-rotation. One extra `adb shell` per `describe` is cheap
 * compared to the uiautomator dump exec-out it sits next to.
 */
export async function getAndroidScreenSize(serial: string): Promise<AndroidScreenSize> {
  const out = await adbShell(serial, "wm size", { timeoutMs: 5_000 });
  const override = out.match(/Override size:\s*(\d+)x(\d+)/);
  const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
  const match = override ?? physical;
  if (!match) {
    throw new Error(`Could not parse screen size from: ${out.trim()}`);
  }
  const width = parseInt(match[1]!, 10);
  const height = parseInt(match[2]!, 10);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error(`Got non-positive screen size from \`wm size\`: ${out.trim()}`);
  }
  return { width, height };
}
