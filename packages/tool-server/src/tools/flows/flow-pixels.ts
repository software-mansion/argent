import * as fs from "node:fs/promises";
import { PNG } from "pngjs";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { httpScreenshot } from "../../utils/simulator-client";
import { settleWithin, sleepOrAbort } from "../../utils/timing";
import type { ActionEnv } from "./flow-actions";

/**
 * A decoded capture used only to detect motion between two reads. Never an
 * artifact — the temp PNG is deleted as soon as it is decoded.
 */
export interface PixelFrame {
  width: number;
  height: number;
  data: Buffer;
}

// Hard downscale: motion detection only needs to see a large region moving,
// and a quarter-scale frame decodes ~16× faster. (Chromium without `sharp`
// ignores the scale and returns full-res — the comparison is scale-agnostic.)
const CAPTURE_SCALE = 0.25;

// Per-pixel RGB tolerance (mirrors screenshot-diff's DEFAULT_THRESHOLD) so
// encoder / resample noise between two captures never reads as motion.
const PIXEL_THRESHOLD = 0.1;
const MAX_RGB_DISTANCE_SQUARED = 255 * 255 * 3;
const PIXEL_THRESHOLD_SQUARED = PIXEL_THRESHOLD * PIXEL_THRESHOLD * MAX_RGB_DISTANCE_SQUARED;

// Captures match when fewer than this fraction of pixels changed — above the
// noise of a blinking cursor or small spinner, far below any screen-filling
// transition.
const MOTION_FRACTION = 0.002;

const PIXEL_SETTLE_POLL_MS = 150;
const PIXEL_SETTLE_TIMEOUT_MS = 2000;

/** Result of a bounded pixel-only settle. */
export type PixelSettleOutcome = "settled" | "timed-out" | "unavailable" | "aborted";

export interface PixelSettleOptions {
  /** Optional caller deadline, further bounded by the two-second pixel window. */
  absoluteDeadline?: number;
}

/**
 * Capture one downscaled screenshot to a temp file. iOS and Android share the
 * simulator-server backend; Chromium uses CDP. Vega has no touch input, so the
 * touch directives this feeds never run there (add a branch if that changes).
 */
async function captureFile(env: ActionEnv): Promise<string | undefined> {
  if (env.device.platform === "vega") return undefined;
  if (env.device.platform === "chromium") {
    const ref = chromiumCdpRef(env.device);
    const api = (await env.registry.resolveService(ref.urn, ref.options)) as ChromiumCdpApi;
    const { path } = await api.captureScreenshot({ scale: CAPTURE_SCALE });
    return path;
  }
  const ref = simulatorServerRef(env.device);
  const api = (await env.registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
  const { path } = await httpScreenshot(api, undefined, env.signal, CAPTURE_SCALE);
  return path;
}

/**
 * One capture as decoded pixels, or `undefined` when pixels can't be read here
 * (no capture source, or any capture / decode failure). Soft by design: the
 * caller treats that as "nothing to wait on" and proceeds.
 */
export async function capturePixels(env: ActionEnv): Promise<PixelFrame | undefined> {
  try {
    const file = await captureFile(env);
    if (!file) return undefined;
    try {
      const png = PNG.sync.read(await fs.readFile(file));
      return { width: png.width, height: png.height, data: png.data };
    } finally {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  } catch {
    return undefined;
  }
}

type BoundedCapture = PixelFrame | "timed-out" | "aborted" | undefined;

/** Wait for one capture without allowing a hung backend to escape `deadline`. */
async function capturePixelsBefore(env: ActionEnv, deadline: number): Promise<BoundedCapture> {
  if (env.signal?.aborted) return "aborted";
  const remaining = deadline - Date.now();
  if (remaining <= 0) return "timed-out";
  const result = await settleWithin(capturePixels(env), remaining, env.signal);
  if (result.type === "aborted" || env.signal?.aborted) return "aborted";
  if (result.type === "timeout") return "timed-out";
  // capturePixels is deliberately soft-failing, but preserve that contract if
  // a future capture implementation lets an error escape.
  if (result.type === "error") return undefined;
  return result.value;
}

/**
 * Wait for two matching pixel captures without consulting the describe tree.
 *
 * Snapshots use this after a combined settle proves the tree source is down:
 * screenshots do not need selector coordinates, but still benefit from a
 * bounded compositor-motion check. A missing capture backend remains distinct
 * from motion exhausting the deadline so callers can report the degradation
 * and apply stricter baseline-write policy to known timeouts.
 */
export async function settlePixels(
  env: ActionEnv,
  options: PixelSettleOptions = {}
): Promise<PixelSettleOutcome> {
  const deadline = Math.min(
    options.absoluteDeadline ?? Number.POSITIVE_INFINITY,
    Date.now() + PIXEL_SETTLE_TIMEOUT_MS
  );
  const first = await capturePixelsBefore(env, deadline);
  if (first === "aborted" || first === "timed-out" || first === undefined) {
    return first === undefined ? "unavailable" : first;
  }

  let previous = first;
  for (;;) {
    const sleepMs = Math.min(PIXEL_SETTLE_POLL_MS, Math.max(0, deadline - Date.now()));
    if (sleepMs <= 0) return "timed-out";
    if (!(await sleepOrAbort(sleepMs, env.signal))) return "aborted";
    const next = await capturePixelsBefore(env, deadline);
    if (next === "aborted" || next === "timed-out" || next === undefined) {
      return next === undefined ? "unavailable" : next;
    }
    if (!pixelsDiffer(previous, next)) return "settled";
    previous = next;
  }
}

/**
 * Did the screen move between two captures? Different dimensions count as
 * motion; otherwise the changed-pixel fraction is compared against
 * {@link MOTION_FRACTION}. Alpha is ignored — a screen capture is opaque.
 */
export function pixelsDiffer(a: PixelFrame, b: PixelFrame): boolean {
  if (a.width !== b.width || a.height !== b.height) return true;
  const total = a.width * a.height;
  if (total === 0) return false;
  const limit = Math.min(a.data.length, b.data.length);
  let changed = 0;
  for (let o = 0; o + 2 < limit; o += 4) {
    const dr = a.data[o] - b.data[o];
    const dg = a.data[o + 1] - b.data[o + 1];
    const db = a.data[o + 2] - b.data[o + 2];
    if (dr * dr + dg * dg + db * db > PIXEL_THRESHOLD_SQUARED) changed++;
  }
  return changed / total > MOTION_FRACTION;
}
