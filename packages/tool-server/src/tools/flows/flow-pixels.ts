import * as fs from "node:fs/promises";
import { PNG } from "pngjs";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { captureVegaScreenshotPng } from "../../utils/vega-screen";
import { FIRST_FRAME_WAIT_MS, httpScreenshot } from "../../utils/simulator-client";
import { settleWithin } from "../../utils/timing";
import { tvScreenshot } from "../screenshot";
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

/** What {@link comparePixels} saw between two captures. */
export type PixelChange = "still" | "localized" | "moving";

// Hard downscale: motion detection only needs to see a large region moving,
// and a quarter-scale frame decodes ~16x faster. (Chromium without `sharp`
// ignores the scale and returns full-res — the comparison is scale-agnostic.)
const CAPTURE_SCALE = 0.25;

// Per-pixel RGB tolerance, owned by this comparison and deliberately NOT
// screenshot-diff's threshold: the two have different noise floors. That one
// holds a baseline PNG stored across sessions, machines and OS versions
// against a live capture, so it must tolerate real drift. This one holds two
// captures one poll apart from ONE live session through one encoder, where a
// static screen normally reads back byte-identical — both capture paths are
// lossless PNG and the CAPTURE_SCALE downscale is deterministic.
//
// The margin is load-bearing because spatially uniform change is
// all-or-nothing: in a cross-fade every pixel moves by the same amount, so it
// either clears the gate on all of them or on none, and MOTION_FRACTION never
// gets consulted. The gate is a Euclidean RGB distance of `threshold * 441.7`:
// 13.25 here, against 44.2 at screenshot-diff's 0.1. A fade goes unseen when it
// moves less than the gate per sample, i.e. when it runs SLOWER than
// `poll * (its total distance) / gate`. For a full-contrast cross-fade
// (distance 441.7, sampled every 200ms) that is ~2s at the baseline tolerance —
// so borrowing it would call any cross-fade slower than two seconds settled
// mid-animation. This value pushes the same blind spot out to ~6.7s, past any
// conventional transition, while keeping a comfortable margin over the
// +5/channel drift the tests treat as the noise floor.
export const PIXEL_THRESHOLD = 0.03;
const MAX_RGB_DISTANCE_SQUARED = 255 * 255 * 3;
const PIXEL_THRESHOLD_SQUARED = PIXEL_THRESHOLD * PIXEL_THRESHOLD * MAX_RGB_DISTANCE_SQUARED;

// The screen is MOVING when at least this fraction of pixels changed —
// counting only pixels that individually clear the per-pixel gate above. It is
// sized for motion worth waiting out: a transition, a scroll, a fade, a
// carousel. Anything smaller is reported separately (see below) rather than
// resetting the settle, because a caret or a spinner never stops, and holding
// a flow for the full timeout over one is worse than telling the author about
// it.
//
// This fraction is NOT what bounds spatially uniform change (a fade, dim, tint
// or scrim): such a change clears the per-pixel gate on either 100% of pixels
// — 500x this fraction — or none of them, so the fraction is never the
// deciding term. What remains is the rate floor described above, a property of
// the gate alone; loosening this fraction does not widen that blind spot.
const MOTION_FRACTION = 0.002;

// Below MOTION_FRACTION but at or above this one, the change is LOCALIZED: too
// small to be the screen moving, too large to be capture noise. A stock 40pt
// spinner measures 0.03-0.15% of a phone screen and a text caret about 0.01%,
// both under MOTION_FRACTION — which is how a still-loading screen used to
// report as settled with nothing said about it.
//
// Both fractions are of frame AREA, which makes them resolution-independent:
// an object of a fixed on-screen size covers the same fraction of the frame
// whatever the capture scale, so the same numbers hold on a 158k-pixel Pixel
// capture and a full-resolution desktop one.
//
// The floor is not zero because a capture pair is not guaranteed byte-identical
// on every backend; it is two orders of magnitude below the smallest spinner
// and one below a caret, which is the widest margin that still sees them.
const LOCALIZED_MOTION_FRACTION = 0.00005;

// `httpScreenshot` may spend its full first-frame wait before it even returns
// a file path. Leave a separate completion margin for reading, decoding, and
// removing that PNG. Warm captures get the tighter bound below.
const FIRST_CAPTURE_COMPLETION_MARGIN_MS = 500;
export const FIRST_PIXEL_CAPTURE_TIMEOUT_MS =
  FIRST_FRAME_WAIT_MS + FIRST_CAPTURE_COMPLETION_MARGIN_MS;
export const PIXEL_CAPTURE_TIMEOUT_MS = 2_000;

/**
 * Per-capture bound — a ceiling, not a wait, so granting more than a route
 * needs costs nothing until it is actually spent.
 *
 * Only a simulator-server-backed capture can spend {@link FIRST_FRAME_WAIT_MS}
 * polling for its stream's first frame. Chromium answers from CDP and Vega
 * shells out to the emulator console, so neither has a stream to warm up and
 * both keep the warm bound throughout. A tvOS simulator shells out too, but it
 * is not distinguishable from an iOS one without an async runtime probe, so it
 * keeps the wider first-capture ceiling it will not use.
 */
export function pixelCaptureTimeoutMs(device: ActionEnv["device"], firstCapture: boolean): number {
  const warmFromTheStart = device.platform === "chromium" || device.platform === "vega";
  return firstCapture && !warmFromTheStart
    ? FIRST_PIXEL_CAPTURE_TIMEOUT_MS
    : PIXEL_CAPTURE_TIMEOUT_MS;
}

/**
 * Capture one downscaled screenshot to a temp file, routed exactly as the
 * `screenshot` tool routes it: Chromium over CDP, tvOS and Vega through their
 * own shells (neither has a simulator-server backend), everything else through
 * the simulator-server both iOS and Android share.
 *
 * The `screenshot` tool itself is deliberately not reused: it registers every
 * capture as an artifact, and a settle takes tens of them per step.
 */
async function captureFile(env: ActionEnv): Promise<string> {
  if (env.device.platform === "chromium") {
    const ref = chromiumCdpRef(env.device);
    const api = (await env.registry.resolveService(ref.urn, ref.options)) as ChromiumCdpApi;
    const { path } = await api.captureScreenshot({ scale: CAPTURE_SCALE });
    return path;
  }
  if (env.device.platform === "vega") {
    return captureVegaScreenshotPng({ scale: CAPTURE_SCALE });
  }
  // Shape alone cannot tell tvOS from iOS — both are 8-4-4-4-12 UUIDs tagged
  // `platform: "ios"` — so ask the runtime, which is memoized per UDID.
  if (env.device.platform === "ios" && (await isTvOsSimulator(env.device.id))) {
    return tvScreenshot(env.device.id, CAPTURE_SCALE, undefined);
  }
  const ref = simulatorServerRef(env.device);
  const api = (await env.registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
  // Deliberately NOT threading env.signal into this capture: the
  // simulator-server writes its temp PNG to disk before replying, and the
  // reply is the only place the path is learned — severing the fetch on abort
  // would orphan that file. Cancellation stays responsive regardless, because
  // callers abandon this promise via settleWithin; the capture just runs to
  // completion on its own bounds, learns the path, and the `finally` in
  // capturePixels removes the file — the same ownership the Chromium arm above
  // has, whose captureScreenshot takes no signal either.
  const { path } = await httpScreenshot(api, undefined, undefined, CAPTURE_SCALE);
  return path;
}

/**
 * One capture as decoded pixels, or `undefined` when the pixels could not be
 * read (any capture or decode failure). Soft by design — the caller treats it
 * as the ABSENCE of visual evidence, never as evidence of stillness.
 */
async function capturePixels(env: ActionEnv): Promise<PixelFrame | undefined> {
  try {
    const file = await captureFile(env);
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

/**
 * One capture bounded by both its own per-capture budget and the caller's
 * deadline. Every way of not getting a frame collapses to `undefined` — the
 * caller has one response to all of them (no visual evidence this round), so
 * distinguishing them here would only invent a difference it cannot act on.
 * Abort is the caller's to notice: it holds the signal and checks it either
 * side of this call.
 */
export async function capturePixelsWithin(
  env: ActionEnv,
  deadline: number,
  firstCapture: boolean
): Promise<PixelFrame | undefined> {
  const budget = Math.min(deadline - Date.now(), pixelCaptureTimeoutMs(env.device, firstCapture));
  if (budget <= 0) return undefined;
  const result = await settleWithin(capturePixels(env), budget, env.signal);
  return result.type === "value" ? result.value : undefined;
}

/**
 * How much of the screen changed between two captures.
 *
 * - `moving` — the screen is in motion and has not settled.
 * - `localized` — something small never stopped: a spinner, a caret, a
 *   progress dot. Not enough to call the screen unsettled, but the caller
 *   reports it, because a spinner means the screen never finished loading and
 *   nothing else here can see the difference.
 * - `still`.
 *
 * Alpha is ignored — a screen capture is opaque.
 *
 * Different dimensions count as motion. That branch covers a resized window
 * (Chromium). It is NOT how a device rotation is caught: the Android capture
 * keeps its portrait shape across one, so rotation registers through content
 * change like anything else.
 */
export function comparePixels(a: PixelFrame, b: PixelFrame): PixelChange {
  if (a.width !== b.width || a.height !== b.height) return "moving";
  const total = a.width * a.height;
  if (total === 0) return "still";
  const limit = Math.min(a.data.length, b.data.length);
  let changed = 0;
  for (let o = 0; o + 2 < limit; o += 4) {
    const dr = a.data[o] - b.data[o];
    const dg = a.data[o + 1] - b.data[o + 1];
    const db = a.data[o + 2] - b.data[o + 2];
    if (dr * dr + dg * dg + db * db > PIXEL_THRESHOLD_SQUARED) changed++;
  }
  const fraction = changed / total;
  if (fraction > MOTION_FRACTION) return "moving";
  return fraction >= LOCALIZED_MOTION_FRACTION ? "localized" : "still";
}
