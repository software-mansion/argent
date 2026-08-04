import * as fs from "node:fs/promises";
import { PNG } from "pngjs";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { getSimulatorRuntimeKind } from "../../utils/ios-devices";
import { FIRST_FRAME_WAIT_MS, httpScreenshot } from "../../utils/simulator-client";
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

// Per-pixel RGB tolerance, owned by the settle and deliberately NOT
// screenshot-diff's DEFAULT_THRESHOLD: the two comparisons have different
// noise floors. That one holds a baseline PNG stored across sessions, machines
// and OS versions against a live capture, so it must tolerate real drift. This
// one holds two captures ~PIXEL_SETTLE_POLL_MS apart from ONE live session
// through one encoder, where a static screen normally reads back byte-identical
// — both capture paths are lossless PNG and the CAPTURE_SCALE downscale is
// deterministic. Borrowing the baseline tolerance put the gate at ~25.5
// levels/channel, orders of magnitude above anything this comparison can
// produce as noise, and that mattered because uniform change is all-or-nothing:
// every pixel moves by the same amount, so it either all clears the gate or
// none of it does and MOTION_FRACTION is never consulted (see below). At ~25.5
// levels a cross-fade slower than ~1.4s counted exactly zero pixels and read as
// settled mid-animation. ~7.6 levels/channel keeps a comfortable margin over
// the +5/channel drift the tests treat as the noise floor while moving that
// cliff out ~3.3x.
export const PIXEL_THRESHOLD = 0.03;
const MAX_RGB_DISTANCE_SQUARED = 255 * 255 * 3;
const PIXEL_THRESHOLD_SQUARED = PIXEL_THRESHOLD * PIXEL_THRESHOLD * MAX_RGB_DISTANCE_SQUARED;

// Captures match when fewer than this fraction of pixels changed — and only
// pixels that individually clear the per-pixel gate above (~7.6 levels/channel
// between consecutive captures) count. That sits above the noise of a blinking
// cursor or small spinner and catches localized motion and moving edges at any
// speed, plus screen-filling changes whose per-interval rate clears the gate.
//
// This fraction is NOT what bounds spatially uniform change (a fade, dim, tint
// or scrim, where every pixel moves by the same amount): such a change either
// clears the per-pixel gate on 100% of pixels — 500x this fraction — or on none
// of them, so the fraction is never the deciding term. Loosening it does not
// widen that class; only the gate above does. What remains is a rate floor, not
// a duration floor: a uniform change moving slower than the gate per sample
// interval contributes zero counted pixels however long it runs or however much
// of the screen it covers. At the current gate that is roughly a fade slower
// than (its total RGB distance / 13.25) x PIXEL_SETTLE_POLL_MS — ~4.5s for a
// full-contrast cross-fade, well past any conventional transition, but a
// documented blindness still: for that class the settle reports `settled` and
// the snapshot degradation note never fires.
const MOTION_FRACTION = 0.002;

// `httpScreenshot` may spend its full first-frame wait before it even returns a
// file path. Leave a separate completion margin for reading, decoding, and
// removing that PNG. Warm captures retain their established two-second bound.
const FIRST_CAPTURE_COMPLETION_MARGIN_MS = 500;
export const FIRST_PIXEL_CAPTURE_TIMEOUT_MS =
  FIRST_FRAME_WAIT_MS + FIRST_CAPTURE_COMPLETION_MARGIN_MS;
export const PIXEL_CAPTURE_TIMEOUT_MS = 2_000;
export const PIXEL_SETTLE_POLL_MS = 150;
export const PIXEL_SETTLE_TIMEOUT_MS =
  FIRST_PIXEL_CAPTURE_TIMEOUT_MS + PIXEL_SETTLE_POLL_MS + PIXEL_CAPTURE_TIMEOUT_MS;

/** Result of a bounded pixel-only settle. */
export type PixelSettleOutcome = "settled" | "timed-out" | "unavailable" | "aborted";

export interface PixelSettleOptions {
  /** Optional caller deadline, further bounded by the shared default pixel window. */
  absoluteDeadline?: number;
}

export type PixelCaptureSupport = "available" | "absent" | "unknown";

// One flow environment reuses its DeviceInfo object across settling and the
// eventual capture. Preserve single-flight while a probe is pending and retain
// fixed available/absent verdicts. An unknown result is transient (simctl may
// have failed or the simulator may not be visible yet), so evict it after all
// callers already sharing that pending promise receive the result.
let pixelCaptureSupportCache = new WeakMap<ActionEnv["device"], Promise<PixelCaptureSupport>>();

/**
 * Resolve pixel support without conflating a failed runtime lookup with iOS.
 * Confirmed tvOS and Vega are architectural absences; confirmed local iOS,
 * ios-remote, Android (including TV), and Chromium are capture-capable.
 */
export function getPixelCaptureSupport(device: ActionEnv["device"]): Promise<PixelCaptureSupport> {
  if (device.platform === "vega") return Promise.resolve("absent");
  if (device.platform !== "ios") return Promise.resolve("available");
  const cached = pixelCaptureSupportCache.get(device);
  if (cached) return cached;
  const pending = getSimulatorRuntimeKind(device.id).then(
    (kind) => (kind === "tv" ? "absent" : kind === "mobile" ? "available" : "unknown"),
    () => "unknown" as const
  );
  pixelCaptureSupportCache.set(device, pending);
  void pending.then((support) => {
    if (support === "unknown" && pixelCaptureSupportCache.get(device) === pending) {
      pixelCaptureSupportCache.delete(device);
    }
  });
  return pending;
}

/** Test-only: isolate per-device capability verdicts. */
export function __resetPixelCaptureSupportCacheForTesting(): void {
  pixelCaptureSupportCache = new WeakMap();
}

/** Per-capture bound within the overall settle window. */
export function pixelCaptureTimeoutMs(device: ActionEnv["device"], firstCapture: boolean): number {
  // Only simulator-server-backed platforms can spend FIRST_FRAME_WAIT_MS
  // polling for their stream's first frame. Chromium is warm-bounded from its
  // first CDP screenshot; Vega never reaches capture.
  return firstCapture && device.platform !== "chromium"
    ? FIRST_PIXEL_CAPTURE_TIMEOUT_MS
    : PIXEL_CAPTURE_TIMEOUT_MS;
}

/**
 * Capture one downscaled screenshot to a temp file. iOS and Android share the
 * simulator-server backend; Chromium uses CDP. Combined settles never reach
 * here for Vega ({@link getPixelCaptureSupport}); the guard covers the pixels-only
 * outage fallback snapshots take when the tree source is down, where
 * `unavailable` is the honest report — nothing gated that capture.
 */
async function captureFile(env: ActionEnv): Promise<string | undefined> {
  if ((await getPixelCaptureSupport(env.device)) !== "available") return undefined;
  if (env.device.platform === "chromium") {
    const ref = chromiumCdpRef(env.device);
    const api = (await env.registry.resolveService(ref.urn, ref.options)) as ChromiumCdpApi;
    const { path } = await api.captureScreenshot({ scale: CAPTURE_SCALE });
    return path;
  }
  const ref = simulatorServerRef(env.device);
  const api = (await env.registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
  // Deliberately NOT threading env.signal into this capture: the
  // simulator-server writes its temp PNG to disk before replying, and the
  // reply is the only place the path is learned — severing the fetch on abort
  // would orphan that file. Cancellation stays responsive regardless, because
  // callers abandon this promise via settleWithin; the capture just runs to
  // completion on its own bounds (the FIRST_FRAME_WAIT_MS poll window plus
  // the server's reply), learns the path, and the `finally` in capturePixels
  // removes the file — the same ownership the Chromium arm above has, whose
  // captureScreenshot takes no signal either.
  const { path } = await httpScreenshot(api, undefined, undefined, CAPTURE_SCALE);
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

/**
 * Wait for one capture within both its own and the overall settle deadline.
 *
 * A budget already spent before the capture could launch deliberately
 * collapses into `timed-out`, UNLIKE the flow-actions twin, whose
 * `not-attempted` stays distinct from `deadline`: its combined settle guards
 * a freshness contract, where zero elapsed time proves the caller's tree
 * still describes the screen. No such contract exists here — this settle's
 * outcome only feeds snapshot degradation reporting (`degradedReason` in
 * flow-visual), where "the settle window expired before stillness was
 * proven" is the honest note whether the window died before the first
 * capture or mid-poll. `aborted` is reserved for real cancellation: the
 * snapshot runner maps it to a skipped step blaming the run's abort.
 */
async function capturePixelsBefore(
  env: ActionEnv,
  overallDeadline: number,
  timeoutMs: number
): Promise<BoundedCapture> {
  if (env.signal?.aborted) return "aborted";
  const deadline = Math.min(overallDeadline, Date.now() + timeoutMs);
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
 * the capture is gated by pixel stability alone, though nothing tree-derived
 * can ever come from this path (see the snapshot settler's `cropOn` notes).
 * A missing capture backend stays distinct from motion exhausting the
 * deadline so callers can report which degradation occurred.
 */
export async function settlePixels(
  env: ActionEnv,
  options: PixelSettleOptions = {}
): Promise<PixelSettleOutcome> {
  const deadline = Math.min(
    options.absoluteDeadline ?? Number.POSITIVE_INFINITY,
    Date.now() + PIXEL_SETTLE_TIMEOUT_MS
  );
  const first = await capturePixelsBefore(env, deadline, pixelCaptureTimeoutMs(env.device, true));
  if (first === "aborted" || first === "timed-out" || first === undefined) {
    return first === undefined ? "unavailable" : first;
  }

  let previous = first;
  for (;;) {
    const sleepMs = Math.min(PIXEL_SETTLE_POLL_MS, Math.max(0, deadline - Date.now()));
    if (sleepMs <= 0) return "timed-out";
    if (!(await sleepOrAbort(sleepMs, env.signal))) return "aborted";
    const next = await capturePixelsBefore(env, deadline, pixelCaptureTimeoutMs(env.device, false));
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
