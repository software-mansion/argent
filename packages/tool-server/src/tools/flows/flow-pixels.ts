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

// Hard downscale: motion detection only needs to see a region of the screen
// change, and a quarter-scale frame decodes ~16x faster. Every route honours
// it, but they do not all collect the saving, because what this constant buys
// is a decode this process does not have to do.
//
// Three of the four keep the large frame out of here entirely: Chromium
// rasterizes at the scale in the compositor (see captureChromiumPng), the
// simulator-server scales inside its own process before it replies, and the
// tvOS route hands the full-resolution capture to `sips`. Each leaves only the
// small PNG to decode.
//
// Vega is the exception, and it is the route where this costs most.
// `captureVegaScreenshotPng` (utils/vega-screen.ts) reads the emulator's
// native-resolution PNG, resamples it with lanczos3 and writes it back out —
// all synchronously — and then `capturePng` reads that file and decodes it a
// second time. So that route pays a full-resolution decode on every poll
// whatever this is set to, plus a resample and a re-encode, all of it blocking
// the shared tool-server's event loop: the same cost captureChromiumPng's note
// measures at ~79ms of every 200ms round and takes off the Chromium path.
// Fixing it belongs in that capture helper, which the `screenshot` tool shares.
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

// The screen is MOVING when more than this fraction of pixels changed AND more
// than MOTION_MIN_PIXELS of them did — counting only pixels that individually
// clear the per-pixel gate above. It is sized for motion worth waiting out: a
// transition, a scroll, a fade, a carousel. Anything smaller is reported
// separately (see below) rather than resetting the settle, because a caret or a
// spinner never stops, and holding a flow for the full timeout over one is
// worse than telling the author about it.
//
// This fraction is NOT what bounds spatially uniform change (a fade, dim, tint
// or scrim): such a change clears the per-pixel gate on either 100% of pixels
// — 500x this fraction — or none of them, so the fraction is never the
// deciding term. What remains is the rate floor described above, a property of
// the gate alone; loosening this fraction does not widen that blind spot.
export const MOTION_FRACTION = 0.002;

// The smallest change that may be called the screen MOVING, whatever the frame
// measures. It exists because the ceiling scales with the frame while the
// localized floor below does not, so without it the band between them closes as
// the frame shrinks: 0.002 of a 100x75 Chromium capture is 15 pixels, leaving
// [10, 15) to hold indicators that measure 50-66.
//
// Closing it is not a silent loss of a warning — it is the opposite verdict.
// `moving` leaves the pixel half of the hold unheld, so the settle restarts
// every round and the step runs to its deadline, then reports "the screen never
// held still ... a video, a looping animation, a carousel" about exactly the
// spinner the band exists to name separately. Measured on this comparison
// before the floor: a 57-pixel indicator read `moving` on 400x300, 500x400 and
// 700x520 CSS windows and `localized` only at 1200x800, so the same indicator
// got opposite verdicts by window size alone.
//
// A hundred clears every indicator measured for the floor below (50-66) by half
// again, and stays far under any real transition: on the smallest frame above
// it is 1.3% of the capture, where a transition, a scroll or a carousel moves a
// large share of it.
const MOTION_MIN_PIXELS = 100;

// ...and the floor itself is capped at this share of the frame, so it can never
// do to a small frame what the fraction alone did: make one verdict
// unreachable. A frame under ~1000 pixels is too small to hold an indicator at
// all, so there is nothing there for the band to protect, and a change covering
// a tenth of the screen is motion whatever its pixel count. Without the cap a
// frame of exactly MOTION_MIN_PIXELS could change every pixel it has and still
// not be called moving. Two orders of magnitude below any real capture, so on a
// device it never binds.
const MOTION_MIN_PIXELS_FRAME_SHARE = 0.1;

// Below the motion threshold but at or above this many CHANGED PIXELS, the
// change is LOCALIZED: too small to be the screen moving, too large to be
// capture noise. A spinner and a caret both sit in that gap — which is how a
// still-loading screen used to report as settled with nothing said about it.
//
// A COUNT, not a fraction, because what these indicators have in common is a
// size in captured pixels rather than a share of the frame. Measured at
// CAPTURE_SCALE: a live spinner changed 50-66 pixels on an iPhone 16 Pro
// (302x656) and 57 on a Pixel 5 (270x585), and a blinking caret 50 on a
// Pixel 7 (162k pixels) — all within a factor of two of each other while the
// frames they sat in differ by more.
//
// The fraction this replaced (0.005% of frame area) had not yet lost any of
// them: on the 2400x2558 Chromium window measured elsewhere in this file it
// works out at 19 captured pixels, and every indicator above clears 19. What it
// did was drift toward them as the window grew, having been derived only from
// phone-sized frames — it would have swallowed the smallest of them on a
// capture past ~1M pixels, with nothing in the number to say where that line
// was. A count does not move.
//
// The floor is not zero because a capture pair is not guaranteed byte-identical
// on every backend; two captures of a static iOS screen changed 0 pixels of
// 237k. Ten sits an order of magnitude under the smallest indicator measured
// and clear of that noise. One smaller than ten pixels stays invisible, which
// is the residual limit of comparing whole frames.
const LOCALIZED_MOTION_MIN_PIXELS = 10;

// Top band excluded from the comparison on a device with a system status bar,
// as a fraction of frame height. The same 6% screenshot-diff ignores
// (DEFAULT_IGNORE_TOP_NORMALIZED_Y), which the `snapshot` step opts into and
// the Android flow tree matches by stripping com.android.systemui outright —
// this comparison was the one place in the repo that looked at system chrome.
//
// It has to be masked here rather than left to the run-level `pinStatusBar`,
// which is not enough on its own for two reasons, both measured. The pin lands
// AFTER the run starts — the simulator repaints the clock and animates the
// battery fill 100-450ms in — so a fragment whose first step is this one
// compares a real clock against a pinned one and calls a static screen moving
// (23 false spinner warnings in 43 runs on an iPhone 16 Pro; 0 in 10 when the
// same step followed a `wait: 2000`). And a nested `tool: flow-execute` clears
// the pin on its way out without the outer run ever re-pinning, leaving every
// later step of that run comparing against a live, ticking clock.
const STATUS_BAR_MASK_FRACTION = 0.06;

/**
 * The fraction of the frame {@link comparePixels} must ignore for this device,
 * because the system paints it and the app does not.
 *
 * Only a phone or tablet puts a status bar in the capture. A Chromium window's
 * top band is page content, and Vega, tvOS and Android TV all render
 * full-screen with no system chrome, so masking any of those would blind the
 * check to real motion for nothing.
 *
 * Neither TV is distinguishable by its platform tag — tvOS is tagged `ios` and
 * leanback is tagged `android` — so each takes the runtime probe its platform
 * provides, the same pairing `await-screen-idle` resolves once per call.
 * Both are memoized per device, and this is resolved once per step rather than
 * once per poll.
 *
 * `ios-remote` is an iOS simulator driven through sim-remote and has the same
 * status bar, so it masks like a local one (flow-run's platform guard folds it
 * the same way). It is not probed for tvOS: the probe reads the LOCAL
 * simulator list, which cannot see a device on another machine, so it would
 * answer "not a TV" without having looked.
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
 * Chromium's downscale, taken from the compositor rather than from `sharp`.
 *
 * The `screenshot` tool's Chromium route resizes the captured PNG with
 * `sharp`, which is an optional dependency nothing in this repo installs — so
 * asking it for a quarter-scale frame returned a full-resolution one, and a
 * settle decoded a 2400x2558 PNG into a 23MB buffer twice a second, blocking
 * the shared tool-server's event loop for ~79ms of every 200ms round.
 *
 * `Page.captureScreenshot`'s own `clip.scale` is applied while rasterizing, so
 * the small frame is the only one that ever exists: no resize step, no
 * dependency, and nothing to decode but the quarter-scale image. `clip` is
 * measured in CSS pixels but its scale composes with the page's device scale
 * factor, so passing CAPTURE_SCALE straight through lands on a quarter of the
 * frame this route used to return — the same reduction every other route
 * applies. Measured on a 900x613 viewport at dpr 2: 1800x1226 and ~25ms of
 * blocking decode per poll became 450x307 and ~3ms.
 *
 * A `clip` is measured from the top of the DOCUMENT, not of the window, so its
 * origin has to follow the scroll — `{ x: 0, y: 0 }` names the top of the page,
 * which on a scrolled document is off-screen and rasterizes as a blank
 * rectangle. Two blank rectangles compare as identical, so that origin made the
 * pixel half of the check vote "still" on every interval of a visibly animating
 * screen, and vote it silently: the capture succeeded, so nothing warned. The
 * offset comes from `Page.getLayoutMetrics`, which is a browser-side read of
 * the frame's own layout — unlike the `Runtime.evaluate` behind the cached
 * viewport, it does not depend on a live main world, so it survives the
 * mid-navigation renderer this check runs against. A page whose scrolling lives
 * in an inner element reports no document scroll and clips at the origin, which
 * is already the right rectangle for it.
 *
 * The viewport SIZE is still the cached one: refreshing it does cost a
 * `Runtime.evaluate` per poll. A window resized mid-step therefore clips
 * against the previous size for the rest of it, and registers as content
 * change like anything else that moves.
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
 * Capture one downscaled screenshot to a temp file: tvOS and Vega through their
 * own shells (neither has a simulator-server backend), everything else through
 * the simulator-server both iOS and Android share. Chromium does not appear
 * here — it answers with bytes, never a file (see captureChromiumPng). Nor does
 * HarmonyOS: `uitest screenCap` is reached only through the `screenshot` tool,
 * which a `snapshot` step invokes (flow-visual.ts) and this path deliberately
 * does not, so the service resolved below refuses the platform outright.
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
    // subprocess becomes a growing pile of them. The `screenshot` tool's own
    // tvOS route has always bounded it the same way. Nothing is orphaned that
    // is not already: on a severed capture the temp path never comes back, but
    // the file is a deterministic one under tmpdir and the alternative is an
    // unbounded process.
    return tvScreenshot(env.device.id, CAPTURE_SCALE, captureAbortSignal(env, budgetMs));
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
 * One capture as PNG bytes. Every route but Chromium's writes a temp file,
 * which is scratch and never an artifact — it is removed as soon as it has
 * been read, whether or not the read worked.
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
 * read (any capture or decode failure). Soft by design — the caller treats it
 * as the ABSENCE of visual evidence, never as evidence of stillness.
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
 * `maskTopFraction` excludes that fraction of rows at the top of the frame,
 * both from the count and from the total the fractions are taken against — see
 * {@link statusBarMaskFraction} for which devices need it and why.
 *
 * Different dimensions count as motion. It is NOT how a device rotation is
 * caught: the Android capture keeps its portrait shape across one, so rotation
 * registers through content change like anything else. On Chromium the branch
 * is effectively unreachable — the clip is built from the cached viewport, so a
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
