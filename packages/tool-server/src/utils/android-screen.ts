import { FAILURE_CODES, FailureError } from "@argent/registry";
import { adbShell } from "./adb";

interface AndroidScreenSize {
  width: number;
  height: number;
}

/**
 * Logical screen size via `wm size`, used as the divisor that normalizes
 * uiautomator's absolute-pixel bounds into the 0–1 coordinate space the tools
 * share. The reported "Override size" wins over "Physical size" when present.
 *
 * `wm size` reports "Physical size: WxH\nOverride size: WxH"; the override
 * wins when present (set by emulators and some system configs).
 *
 * IMPORTANT: this reports the *unrotated* size. Measured on a landscape Pixel_9
 * (API 36) whose display really was 2424x1080: `wm size` still answered
 * "Physical size: 1080x2424" with no Override line. So the returned size must be
 * oriented by the caller — see `orientScreenSize` — before it is used as a
 * divisor for rotated bounds; assuming the opposite is what made the legacy
 * describe path wrong on a rotated device (#609).
 *
 * Deliberately uncached: rotation changes the size within a describe's
 * lifetime (it completes in <500 ms), and a stale divisor yields frames with x
 * or width above 1. One extra `adb shell` per `describe` is cheap next to the
 * uiautomator dump it sits beside.
 */
export async function getAndroidScreenSize(serial: string): Promise<AndroidScreenSize> {
  const out = await adbShell(serial, "wm size", { timeoutMs: 5_000 });
  const override = out.match(/Override size:\s*(\d+)x(\d+)/);
  const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
  const match = override ?? physical;
  if (!match) {
    throw new FailureError(`Could not parse screen size from: ${out.trim()}`, {
      error_code: FAILURE_CODES.ANDROID_SCREEN_SIZE_PARSE_FAILED,
      failure_stage: "android_screen_size_parse",
      failure_area: "tool_server",
      error_kind: "subprocess",
    });
  }
  const width = parseInt(match[1]!, 10);
  const height = parseInt(match[2]!, 10);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new FailureError(`Got non-positive screen size from \`wm size\`: ${out.trim()}`, {
      error_code: FAILURE_CODES.ANDROID_SCREEN_SIZE_NON_POSITIVE,
      failure_stage: "android_screen_size_validate",
      failure_area: "tool_server",
      error_kind: "subprocess",
    });
  }
  return { width, height };
}

/**
 * The surface rotation a uiautomator dump was taken at, read from the dump
 * itself: `<hierarchy rotation="1">`.
 *
 * Taking it from the XML rather than asking the device again is deliberate. It
 * costs no extra round-trip, it cannot disagree with the bounds it is used to
 * normalize (a rotation between the two calls would), and — most importantly —
 * the legacy path runs precisely when the android-devtools helper could not be
 * reached, which is when the device is least likely to answer more adb probes.
 *
 * Returns null when absent, which keeps pre-rotation-attribute dumps working.
 */
export function parseDumpRotation(rawOutput: string): 0 | 1 | 2 | 3 | null {
  const value = Number(/<hierarchy[^>]*\brotation="([0-3])"/.exec(rawOutput)?.[1]);
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  return null;
}

/**
 * Swap width and height when the device is on its side, so the result describes
 * the display as it is currently laid out.
 *
 * uiautomator reports node bounds against the rotated display, so on a rotated
 * device the unrotated `wm size` is the wrong divisor in both axes. The visible
 * consequence was not merely squashed frames: `isVisibleRect` drops any node
 * whose left edge is past the screen width, so with a 1080-wide divisor against
 * a 2424-wide display, everything on the right-hand half of the screen
 * disappeared from the tree entirely.
 */
export function orientScreenSize(
  size: AndroidScreenSize,
  rotation: 0 | 1 | 2 | 3 | null
): AndroidScreenSize {
  if (rotation !== 1 && rotation !== 3) return size;
  return { width: size.height, height: size.width };
}
