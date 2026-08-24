import * as fs from "node:fs/promises";
import { PNG } from "pngjs";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { isAndroidTv } from "../../utils/adb";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { captureVegaScreenshotPng } from "../../utils/vega-screen";
import { FIRST_FRAME_WAIT_MS, httpScreenshot } from "../../utils/simulator-client";
import { settleWithin } from "../../utils/timing";
import { tvScreenshot } from "../screenshot";
import type { ActionEnv } from "./flow-actions";

/**
 * A decoded capture, used only to detect motion between two reads. Never an
 * artifact — the temp PNG is deleted as soon as it is decoded.
 */
export interface PixelFrame {
  width: number;
  height: number;
  data: Buffer;
}

/** What {@link comparePixels} saw between two captures. */
export type PixelChange = "still" | "localized" | "moving";

// Motion detection only needs to see a region of the screen change, and a
// quarter-scale frame decodes ~16x faster. Chromium rasterizes at this scale in
// the compositor, the simulator-server scales inside its own process before it
// replies and the tvOS route downscales with `sips`, so those three leave only
// a small PNG to decode here. Vega is the exception and pays the most:
// `captureVegaScreenshotPng` (utils/vega-screen.ts) decodes the emulator's
// native-resolution PNG, resamples it and writes it back out before `capturePng`
// decodes it a second time — a full-resolution decode per poll whatever this is
// set to, on the shared tool-server's event loop.
const CAPTURE_SCALE = 0.25;

// Per-pixel RGB tolerance, owned by this comparison and deliberately NOT
// screenshot-diff's 0.1: the two have different noise floors. That one holds a
// baseline PNG stored across sessions, machines and OS versions against a live
// capture, so it must tolerate real drift. This one holds two captures one poll
// apart from ONE session through one lossless encoder, where a static screen
// normally reads back byte-identical.
//
// The margin is load-bearing because spatially uniform change is
// all-or-nothing: in a cross-fade every pixel moves by the same amount, so it
// clears the gate on all of them or on none and MOTION_FRACTION is never
// consulted. The gate is a Euclidean RGB distance of `threshold * 441.7` — 13.25
// here against 44.2 at screenshot-diff's tolerance — and a fade goes unseen when
// it moves less than that per 200ms sample. For a full-contrast cross-fade that
// is ~6.7s here, but only ~2s at the borrowed tolerance, which would call any
// slower cross-fade settled mid-animation.
export const PIXEL_THRESHOLD = 0.03;
const MAX_RGB_DISTANCE_SQUARED = 255 * 255 * 3;
const PIXEL_THRESHOLD_SQUARED = PIXEL_THRESHOLD * PIXEL_THRESHOLD * MAX_RGB_DISTANCE_SQUARED;

// The screen is MOVING when more than this fraction of pixels changed AND more
// than MOTION_MIN_PIXELS of them did. Sized for motion worth waiting out: a
// transition, a scroll, a fade, a carousel. Anything smaller is reported as
// `localized` rather than resetting the settle, because a caret or a spinner
// never stops, and holding a flow for the full timeout over one is worse than
// telling the author about it.
//
// This fraction is NOT what bounds spatially uniform change (a fade, dim, tint
// or scrim): that clears the per-pixel gate on every pixel or on none, so
// loosening the fraction does not widen the rate blind spot described above.
export const MOTION_FRACTION = 0.002;

// The smallest change that may be called MOVING, whatever the frame measures.
// The ceiling scales with the frame while the localized floor below does not, so
// without it the band between them closes as the frame shrinks: 0.002 of a
// 100x75 Chromium capture is 15 pixels, leaving [10, 15) to hold indicators that
// measure 50-66.
//
// A closed band is not a lost warning but the opposite verdict: `moving` leaves
// the pixel half of the hold unheld, so the step runs to its deadline and then
// reports "the screen never held still ... a video, a looping animation, a
// carousel" about exactly the spinner the band exists to name separately.
// Measured before the floor, a 57-pixel indicator read `moving` on 400x300,
// 500x400 and 700x520 CSS windows and `localized` only at 1200x800.
//
// A hundred clears every indicator measured for the floor below (50-66) by half
// again, and on the smallest frame above is still only 1.3% of the capture,
// where a transition or a scroll moves a large share.
const MOTION_MIN_PIXELS = 100;

// ...and the floor itself is capped at this share of the frame, so it can never
// do to a small frame what the fraction alone did: make one verdict
// unreachable. Without the cap a frame of exactly MOTION_MIN_PIXELS could change
// every pixel it has and still not be called moving. It only binds under ~1000
// pixels — too small to hold an indicator at all, and two orders of magnitude
// below any real capture.
const MOTION_MIN_PIXELS_FRAME_SHARE = 0.1;

// Below the motion threshold but at or above this many CHANGED PIXELS, the
// change is LOCALIZED: too small to be the screen moving, too large to be
// capture noise. A spinner and a caret both sit in that gap — which is how a
// still-loading screen used to report as settled with nothing said about it.
//
// A COUNT, not a fraction, because what these indicators have in common is a
// size in captured pixels rather than a share of the frame. Measured at
// CAPTURE_SCALE: a live spinner changed 50-66 pixels on an iPhone 16 Pro
// (302x656) and 57 on a Pixel 5 (270x585), and a blinking caret 50 on a Pixel 7
// (162k pixels) — all within a factor of two of each other while the frames they
// sat in differ by more. The fraction this replaced (0.005% of frame area) was
// derived from phone-sized frames alone and drifted toward them as the window
// grew, with nothing in the number to say where it would swallow them.
//
// The floor is not zero because a capture pair is not guaranteed byte-identical
// on every backend. A change smaller than ten pixels stays invisible, which is
// the residual limit of comparing whole frames.
const LOCALIZED_MOTION_MIN_PIXELS = 10;

// Top band excluded from the comparison on a device with a system status bar,
// as a fraction of frame height. The same 6% screenshot-diff ignores
// (DEFAULT_IGNORE_TOP_NORMALIZED_Y) and the Android flow tree matches by
// stripping com.android.systemui outright.
//
// It has to be masked here rather than left to the run-level `pinStatusBar`,
// which is not enough on its own for two measured reasons. The pin lands AFTER
// the run starts — the simulator repaints the clock and animates the battery
// fill 100-450ms in — so a fragment whose first step is this one compares a real
// clock against a pinned one and calls a static screen moving (23 false spinner
// warnings in 43 runs on an iPhone 16 Pro; 0 in 10 behind a `wait: 2000`). And a
// nested `tool: flow-execute` clears the pin on its way out without the outer
// run ever re-pinning.
const STATUS_BAR_MASK_FRACTION = 0.06;

/**
 * The fraction of the frame {@link comparePixels} must ignore for this device,
 * because the system paints it and the app does not.
 *
 * Only a phone or tablet puts a status bar in the capture. A Chromium window's
 * top band is page content, and Vega, tvOS and Android TV all render
 * full-screen, so masking any of those would blind the check to real motion for
 * nothing.
 *
 * Neither TV is distinguishable by its platform tag — tvOS is tagged `ios` and
 * leanback is tagged `android` — so each takes the runtime probe its platform
 * provides, the same pairing `await-screen-idle` resolves once per call. Both
 * are memoized per device, and this is resolved once per step, not per poll.
 *
 * `ios-remote` is an iOS simulator driven through sim-remote and has the same
 * status bar, so it masks like a local one. It is not probed for tvOS: the probe
 * reads the LOCAL simulator list, which cannot see a device on another machine,
 * so it would answer "not a TV" without having looked.
 */
export async function statusBarMaskFraction(device: ActionEnv["device"]): Promise<number> {
  if (device.platform === "android") {
    return (await isAndroidTv(device.id)) ? 0 : STATUS_BAR_MASK_FRACTION;
  }
  if (device.platform === "ios-remote") return STATUS_BAR_MASK_FRACTION;
  if (device.platform !== "ios") return 0;
  return (await isTvOsSimulator(device.id)) ? 0 : STATUS_BAR_MASK_FRACTION;
}

// `httpScreenshot` may spend its full first-frame wait before it even returns
// a file path. Leave a separate completion margin for reading, decoding, and
// removing that PNG. Warm captures get the tighter bound below.
const FIRST_CAPTURE_COMPLETION_MARGIN_MS = 500;
export const FIRST_PIXEL_CAPTURE_TIMEOUT_MS =
  FIRST_FRAME_WAIT_MS + FIRST_CAPTURE_COMPLETION_MARGIN_MS;
export const PIXEL_CAPTURE_TIMEOUT_MS = 2_000;

/**
 * Per-capture bound — a ceiling, not a wait, so granting more than a route needs
 * costs nothing until it is actually spent.
 *
 * Only a simulator-server-backed capture can spend {@link FIRST_FRAME_WAIT_MS}
 * polling for its stream's first frame. Chromium answers from CDP and Vega
 * shells out to the emulator console, so neither has a stream to warm up. A tvOS
 * simulator shells out too, but is not distinguishable from an iOS one without
 * an async runtime probe, so it keeps the wider ceiling it will not use.
 */
export function pixelCaptureTimeoutMs(device: ActionEnv["device"], firstCapture: boolean): number {
  const warmFromTheStart = device.platform === "chromium" || device.platform === "vega";
  return firstCapture && !warmFromTheStart
    ? FIRST_PIXEL_CAPTURE_TIMEOUT_MS
    : PIXEL_CAPTURE_TIMEOUT_MS;
}

/**
 * Chromium's downscale, taken from the compositor rather than from `sharp`.
 *
 * The `screenshot` tool's Chromium route resizes the captured PNG with `sharp`,
 * an optional dependency nothing in this repo installs — so asking it for a
 * quarter-scale frame returned a full-resolution one, and a settle decoded a
 * 2400x2558 PNG into a 23MB buffer twice a second, blocking the shared
 * tool-server's event loop for ~79ms of every 200ms round.
 * `Page.captureScreenshot`'s own `clip.scale` is applied while rasterizing, so
 * the small frame is the only one that ever exists. `clip` is measured in CSS
 * pixels but its scale composes with the page's device scale factor, so passing
 * CAPTURE_SCALE straight through lands on the same quarter every other route
 * applies: measured on a 900x613 viewport at dpr 2, 1800x1226 and ~25ms of
 * blocking decode per poll became 450x307 and ~3ms.
 *
 * A `clip` is measured from the top of the DOCUMENT, not of the window, so its
 * origin has to follow the scroll — `{ x: 0, y: 0 }` on a scrolled document is
 * off-screen and rasterizes as a blank rectangle. Two blank rectangles compare
 * as identical, so that origin made this check vote "still" on every interval of
 * a visibly animating screen, and vote it silently: the capture succeeded, so
 * nothing warned. `Page.getLayoutMetrics` is a browser-side read of the frame's
 * own layout — unlike the `Runtime.evaluate` behind the cached viewport, it does
 * not need a live main world, so it survives the mid-navigation renderer this
 * check runs against. A page whose scrolling lives in an inner element reports
 * no document scroll and clips at the origin, which is already right for it.
 *
 * The viewport SIZE is still the cached one, because refreshing it costs a
 * `Runtime.evaluate` per poll. A window resized mid-step therefore clips against
 * the previous size for the rest of it.
 */
async function captureChromiumPng(env: ActionEnv): Promise<Buffer> {
  const ref = chromiumCdpRef(env.device);
  const api = (await env.registry.resolveService(ref.urn, ref.options)) as ChromiumCdpApi;
  const { width, height } = api.getViewport();
  const { x, y } = await chromiumScrollOffset(api);
  const shot = (await api.cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale: CAPTURE_SCALE },
  })) as { data?: string };
  if (!shot.data) throw new Error("Page.captureScreenshot returned no data");
  return Buffer.from(shot.data, "base64");
}

/** What `Page.getLayoutMetrics` reports about where the window sits in the page. */
interface CssViewportMetrics {
  pageX?: number;
  pageY?: number;
}

/**
 * Where the window's top-left corner sits in document coordinates, in CSS
 * pixels — the origin {@link captureChromiumPng} must clip from.
 *
 * `cssVisualViewport` is preferred because it also carries a pinch-zoom offset;
 * `cssLayoutViewport` is the fallback for a protocol that predates it. A read
 * that fails or answers with nothing usable falls back to the document origin,
 * which is the unscrolled answer and no worse than not asking.
 */
async function chromiumScrollOffset(api: ChromiumCdpApi): Promise<{ x: number; y: number }> {
  try {
    const metrics = (await api.cdp.send("Page.getLayoutMetrics")) as {
      cssVisualViewport?: CssViewportMetrics;
      cssLayoutViewport?: CssViewportMetrics;
      layoutViewport?: CssViewportMetrics;
    };
    const vp = metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? metrics.layoutViewport;
    const x = vp?.pageX;
    const y = vp?.pageY;
    return {
      x: typeof x === "number" && Number.isFinite(x) ? x : 0,
      y: typeof y === "number" && Number.isFinite(y) ? y : 0,
    };
  } catch {
    return { x: 0, y: 0 };
  }
}

/**
 * Capture one downscaled screenshot to a temp file, routed exactly as the
 * `screenshot` tool routes it: tvOS and Vega through their own shells (neither
 * has a simulator-server backend), everything else through the simulator-server
 * both iOS and Android share. Chromium does not appear here — it answers with
 * bytes, never a file (see captureChromiumPng).
 *
 * The `screenshot` tool itself is deliberately not reused: it registers every
 * capture as an artifact, and a settle takes tens of them per step.
 */
async function captureFile(env: ActionEnv, budgetMs: number): Promise<string> {
  if (env.device.platform === "vega") {
    return captureVegaScreenshotPng({ scale: CAPTURE_SCALE });
  }
  // Shape alone cannot tell tvOS from iOS — both are 8-4-4-4-12 UUIDs tagged
  // `platform: "ios"` — so ask the runtime, which is memoized per UDID.
  if (env.device.platform === "ios" && (await isTvOsSimulator(env.device.id))) {
    // This one DOES take the signal, unlike the simulator-server arm below.
    // `tvScreenshot` forwards it to `execFileAsync`, and without it a wedged
    // `xcrun simctl io screenshot` is never killed — the round abandons the
    // promise and the next poll 200ms later spawns another, so a stuck
    // subprocess becomes a growing pile of them. The cost is a temp file left
    // behind when a severed capture never returns its path.
    return tvScreenshot(env.device.id, CAPTURE_SCALE, captureAbortSignal(env, budgetMs));
  }
  const ref = simulatorServerRef(env.device);
  const api = (await env.registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
  // Deliberately NOT threading env.signal into this capture: the
  // simulator-server writes its temp PNG to disk before replying, and the reply
  // is the only place the path is learned — severing the fetch on abort would
  // orphan that file. Cancellation stays responsive regardless, because callers
  // abandon this promise via settleWithin; the capture runs to completion on its
  // own bounds, learns the path, and the `finally` in capturePixels removes the
  // file.
  const { path } = await httpScreenshot(api, undefined, undefined, CAPTURE_SCALE);
  return path;
}

/**
 * One capture as PNG bytes. Every route but Chromium's writes a temp file, which
 * is scratch and never an artifact — it is removed as soon as it has been read,
 * whether or not the read worked.
 */
async function capturePng(env: ActionEnv, budgetMs: number): Promise<Buffer> {
  if (env.device.platform === "chromium") return captureChromiumPng(env);
  const file = await captureFile(env, budgetMs);
  try {
    return await fs.readFile(file);
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

/**
 * One capture as decoded pixels, or `undefined` when the pixels could not be
 * read (any capture or decode failure). Soft by design — the caller treats it as
 * the ABSENCE of visual evidence, never as evidence of stillness.
 */
async function capturePixels(env: ActionEnv, budgetMs: number): Promise<PixelFrame | undefined> {
  try {
    const png = PNG.sync.read(await capturePng(env, budgetMs));
    return { width: png.width, height: png.height, data: png.data };
  } catch {
    return undefined;
  }
}

/**
 * One capture bounded by both its own per-capture budget and the caller's
 * deadline. Every way of not getting a frame collapses to `undefined` — the
 * caller has one response to all of them, so distinguishing them here would only
 * invent a difference it cannot act on. Abort is the caller's to notice: it
 * holds the signal and checks it either side of this call.
 */
export async function capturePixelsWithin(
  env: ActionEnv,
  deadline: number,
  firstCapture: boolean
): Promise<PixelFrame | undefined> {
  const budget = Math.min(deadline - Date.now(), pixelCaptureTimeoutMs(env.device, firstCapture));
  if (budget <= 0) return undefined;
  const result = await settleWithin(capturePixels(env, budget), budget, env.signal);
  return result.type === "value" ? result.value : undefined;
}

/**
 * The signal a shell-out capture is bounded by: the run's own abort, plus this
 * capture's budget, so the subprocess dies with the round that stopped waiting
 * for it rather than outliving the whole step.
 */
function captureAbortSignal(env: ActionEnv, budgetMs: number): AbortSignal {
  const bound = AbortSignal.timeout(budgetMs);
  return env.signal ? AbortSignal.any([env.signal, bound]) : bound;
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
 * `maskTopFraction` excludes that fraction of rows at the top of the frame, both
 * from the count and from the total the fractions are taken against — see
 * {@link statusBarMaskFraction} for which devices need it and why.
 *
 * Different dimensions count as motion, but that is NOT how a device rotation is
 * caught: the Android capture keeps its portrait shape across one, so rotation
 * registers through content change like anything else. On Chromium the branch is
 * effectively unreachable — the clip is built from the cached viewport, so a
 * resize does not change the captured dimensions until something refreshes it.
 */
export function comparePixels(a: PixelFrame, b: PixelFrame, maskTopFraction = 0): PixelChange {
  if (a.width !== b.width || a.height !== b.height) return "moving";
  const maskedRows = Math.min(a.height, Math.floor(a.height * maskTopFraction));
  const total = a.width * (a.height - maskedRows);
  if (total <= 0) return "still";
  const limit = Math.min(a.data.length, b.data.length);
  let changed = 0;
  for (let o = maskedRows * a.width * 4; o + 2 < limit; o += 4) {
    const dr = a.data[o] - b.data[o];
    const dg = a.data[o + 1] - b.data[o + 1];
    const db = a.data[o + 2] - b.data[o + 2];
    if (dr * dr + dg * dg + db * db > PIXEL_THRESHOLD_SQUARED) changed++;
  }
  const motionThreshold = Math.max(
    total * MOTION_FRACTION,
    Math.min(MOTION_MIN_PIXELS, total * MOTION_MIN_PIXELS_FRAME_SHARE)
  );
  if (changed > motionThreshold) return "moving";
  return changed >= LOCALIZED_MOTION_MIN_PIXELS ? "localized" : "still";
}
