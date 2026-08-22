import { FAILURE_CODES, FailureError } from "@argent/registry";
import { adbShell } from "./adb";

export interface AndroidScreenSize {
  width: number;
  height: number;
}

/**
 * Logical screen size via `wm size`, used as the divisor that normalizes
 * uiautomator's absolute-pixel bounds into the 0–1 coordinate space the tools
 * share. The reported "Override size" wins over "Physical size" when present.
 *
 * Deliberately uncached: rotation changes the size within a describe's lifetime,
 * and a stale divisor yields frames with x or width above 1.
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
