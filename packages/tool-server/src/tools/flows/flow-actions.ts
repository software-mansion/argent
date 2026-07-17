import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import {
  getDescribeTapPoint,
  type DescribeFrame,
  type DescribeNode,
  type DescribeSource,
} from "../describe/contract";
import {
  selectorToFrame,
  findAll,
  evaluateCondition,
  firstInReadingOrder,
  frameContains,
  isVisible,
  assertText,
  nodeText,
  treeFingerprint,
  type Selector,
  type WaitCondition,
  type TextMatchMode,
} from "../../utils/ui-tree-match";
import { settleWithin, sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import { bindDeviceArgs } from "./flow-device";
import { FlowTreeSourceUnavailableError } from "./flow-errors";
import { fetchFlowTree } from "./flow-tree";
import { capturePixels, pixelsDiffer, type PixelSettleOutcome } from "./flow-pixels";
import {
  buildAxisCandidate,
  decomposePinch,
  selectPinchCandidate,
  systemEdgeGuards,
  PINCH_SETTLE_MS,
  type PinchCandidate,
} from "./flow-pinch-geometry";
import {
  describeSelector,
  describeTextExpectation,
  type FlowSelector,
  type FlowStep,
  type ScrollDirection,
} from "./flow-utils";

/** Everything a directive needs to act on the run's device. */
export interface ActionEnv {
  registry: Registry;
  ctx?: ToolContext;
  device: DeviceInfo;
  signal?: AbortSignal;
}

/** Outcome of a selector directive: ok, or a machine-readable reason it failed. */
export interface DirectiveOutcome {
  ok: boolean;
  reason?: string;
  /** The run was cancelled mid-step — reported as a skip, not a step failure. */
  aborted?: boolean;
  /**
   * The condition could not be evaluated — unknown, not false: the window
   * never produced a trustworthy read (every fetch threw or returned a
   * blind/degraded tree), or a `hidden` check ended on a blind or failed
   * read after the element had matched. Read by the `when:` guard probe,
   * which must error rather than silently skip a block a broken tree source
   * can't vouch for; a plain `assert` reports it as an ordinary failure.
   */
  indeterminate?: boolean;
}

/**
 * The uniform outcome for a step cut short by run cancellation (directives
 * here, `launch` in flow-run.ts). The runner reports it as skip + "run aborted"
 * (matching the pre-step guard and `wait`) — an aborted run says nothing about
 * the app, so it must never read as a genuine step failure with a misleading
 * reason.
 */
export const ABORTED_OUTCOME: DirectiveOutcome = {
  ok: false,
  aborted: true,
  reason: "run aborted",
};

/** The selector-acting steps {@link runDirective} handles. */
export type DirectiveStep = Extract<
  FlowStep,
  { kind: "tap" | "long-press" | "type" | "await" | "assert" | "scroll-to" | "pinch" }
>;

/** Dispatch a tool with the run's resolved device id bound into its args. */
export function invokeOnDevice(
  env: ActionEnv,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return invokeSubTool(
    env.registry,
    env.ctx,
    tool,
    bindDeviceArgs(env.registry, tool, env.device.id, args)
  );
}

const DEFAULT_ACTION_TIMEOUT_MS = 7500;
const POLL_INTERVAL_MS = 300;

// `type` focus handshake: the focus tap resolves as soon as its Up event is
// enqueued, but the app still has to move input focus there (first responder /
// IME focus; an RN TextInput adds a JS round-trip) — keys injected before that
// land in the previously-focused element. TYPE_FOCUS_SETTLE_MS is an
// unconditional head start after the tap; `waitForFocus` then polls, on
// sources that report focus, until the tapped frame holds it.
const TYPE_FOCUS_SETTLE_MS = 500;
const TYPE_FOCUS_TIMEOUT_MS = 3000;

// Tree sources that surface `focused` (see flow-ios-tree / flow-android-tree /
// the chromium DOM walker). A source outside this set (e.g. Vega's toolkit
// page source) never reports it, so polling would burn the whole timeout on
// every type step — skip the focus wait there instead.
const FOCUS_REPORTING_SOURCES: ReadonlySet<DescribeSource> = new Set([
  "native-devtools",
  "android-devtools",
  "cdp-dom",
]);

// Settle detection: re-read the tree until two consecutive reads match, so a tap
// never lands mid-fling and a resolved frame can't go stale before we act.
const SETTLE_POLL_MS = 250;
const SETTLE_TIMEOUT_MS = 3000;

// Pixel settle backstop: the tree fingerprint can't see visual motion the
// reported geometry never reflects. Canonical case: an iOS Core Animation
// transition (modal dismiss, nav push) sets the model frame to its final value
// when the animation STARTS and animates only the presentation layer — which
// keeps hit-testing — so a settled tree can still be covered by a dismissing
// modal. Same blindness for Android window animations and Chromium opacity
// fades. So once the tree converges, confirm the pixels stopped too. Bounded
// so a perpetual animator adds at most this much per combined settle. A
// `scroll-to` uses this only before its first increment; later checkpoints are
// tree-only because each increment is already momentum-free/settled.
const PIXEL_SETTLE_POLL_MS = 150;
const PIXEL_SETTLE_TIMEOUT_MS = 2000;
// Leave one bounded tree-read window after the pixel phase. Without this
// reserve a hung capture can consume the caller's entire deadline, leaving no
// opportunity to prove that the pre-capture selector coordinates are current.
const FINAL_TREE_REVALIDATE_RESERVE_MS = SETTLE_POLL_MS;
const COMBINED_SETTLE_TIMEOUT_MS = SETTLE_TIMEOUT_MS + PIXEL_SETTLE_TIMEOUT_MS;

// `scroll-to`: a bounded number of momentum-free increments. Each travels half
// the clip window along the scroll axis (half the screen when no `within`
// container is named) — < 1 viewport, so consecutive viewports overlap and a
// target can never be skipped over between two settle checkpoints. The floor
// keeps the gesture in a tiny container large enough to register as a scroll
// rather than a tap.
const MAX_SCROLL_ITERATIONS = 25;
const SCROLL_INCREMENT = 0.5;
const MIN_SCROLL_INCREMENT = 0.05;

const FULL_SCREEN: DescribeFrame = { x: 0, y: 0, width: 1, height: 1 };

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Edge tolerance (normalized) for "is this frame flush against a clip edge".
// A hair above the frame-fingerprint rounding (1e-3) so sub-pixel jitter never
// reads as a clip, but small enough that a genuinely clipped edge lands on it.
const EDGE_EPS = 0.005;

/**
 * Is `frame` as visible as it can get within `clip` along the scroll axis?
 * True in either of two shapes:
 *
 * 1. Fully within the clip, with its *entry* edge cleared of the clip boundary
 *    by a margin. Every describe adapter clips a partly-scrolled element's
 *    frame to the viewport (iOS/Chromium clamp their rects to [0,1]; Android
 *    uiautomator reports bounds already clipped to the scroll container), so
 *    such an element sits exactly flush against the edge it is being revealed
 *    from — a row entering from the bottom has `y+h == clip.bottom`. "Flush
 *    against the entry edge" is therefore the universal clipped signal.
 *    Requiring the entry edge strictly inside (by `EDGE_EPS`), with the
 *    opposite edge still within the clip, means the whole element has cleared
 *    the fold. The entry edge is set by the scroll direction: `down` reveals
 *    from the bottom, `up` from the top, etc.
 * 2. Spanning the whole clip along the axis (both clip edges covered, with
 *    `EDGE_EPS` slack). A target as tall/wide as the clip — or larger — can
 *    never fit both edges inside it, so shape 1 is arithmetically
 *    unsatisfiable for it; once it covers the clip, no scroll can reveal more
 *    of it, so it is accepted where it stands. Without this, a full-screen
 *    target would scroll (and could burn every iteration when an in-region
 *    animation defeats the end-of-scroll fingerprint) despite being on screen
 *    the whole time.
 */
function axisFullyInside(
  frame: DescribeFrame,
  direction: ScrollDirection,
  clip: DescribeFrame
): boolean {
  const vertical = direction === "down" || direction === "up";
  const clipStart = vertical ? clip.y : clip.x;
  const clipEnd = clipStart + (vertical ? clip.height : clip.width);
  const fStart = vertical ? frame.y : frame.x;
  const fEnd = fStart + (vertical ? frame.height : frame.width);
  // Shape 2: the target covers the whole clip window along the axis.
  if (fStart <= clipStart + EDGE_EPS && fEnd >= clipEnd - EDGE_EPS) return true;
  // Shape 1: both edges inside, entry edge (per direction) cleared by EDGE_EPS.
  // `down`/`right` reveal from the end edge; `up`/`left` from the start edge.
  return direction === "down" || direction === "right"
    ? fEnd <= clipEnd - EDGE_EPS && fStart >= clipStart - EDGE_EPS
    : fStart >= clipStart + EDGE_EPS && fEnd <= clipEnd + EDGE_EPS;
}

// `assert` is a correctness check, not an open-ended wait — but UI updates after
// an action land asynchronously, so a strictly one-shot read races the
// re-render (e.g. a counter that increments a frame after a tap). Like
// Playwright's web-first assertions, assert retries for a short grace window so
// it absorbs that latency; a genuinely-false assertion still fails quickly.
const DEFAULT_ASSERT_TIMEOUT_MS = 1000;

// Evidence-gap bound for `waitForCondition`'s post-timeout verdict: how far
// behind the loop's exit the last TRUSTED read may lie before a determinate
// "condition false" verdict stops being honest. Two poll intervals budgets
// the worst genuine last-poll blip — up to one interval of sleep since the
// last clean read, plus an interval's worth of latency for the deadline poll
// and its back-to-back final retry both failing.
// Anything longer means consecutive polls went dark, and a verdict narrated
// from the reads before the darkness would describe a screen nobody saw at
// the deadline.
const CONDITION_DARK_TAIL_TOLERANCE_MS = POLL_INTERVAL_MS * 2;

/**
 * Evaluate a `when:` block's UI guard — the same engine as `assert`, on the
 * same assert grace window: a skipped block must not add an await-sized dead
 * wait to every clean run. `ok` is "condition met"; `indeterminate`
 * distinguishes an unreadable tree (the caller errors — unknown is not false)
 * from a plainly unmet condition (the caller skips).
 */
export function probeWhenCondition(
  env: ActionEnv,
  cond: {
    condition: WaitCondition;
    selector: FlowSelector;
    expectedText?: string;
    textMatch?: TextMatchMode;
  }
): Promise<DirectiveOutcome> {
  return waitForCondition(env, cond, DEFAULT_ASSERT_TIMEOUT_MS);
}

/**
 * The strict selectors a flow selector resolves through, in order. A loose
 * selector (bare-string sugar, `tap: foo`) tries the identifier locator first
 * and falls back to text (label/value) only when that finds nothing — so a
 * hand-written `foo` matches a `testID="foo"` as well as visible text. Explicit
 * `{ text }` / `{ id }` selectors carry no flag and match strictly.
 * Lives in the flow runner only; the shared match engine and the tools that
 * consume it are untouched.
 */
function selectorAlternatives(sel: FlowSelector): Selector[] {
  return sel.loose && sel.text !== undefined
    ? [{ identifier: sel.text }, { text: sel.text }]
    : [sel];
}

/**
 * Resolve a selector's matches honoring the bare-string `loose` fallback. A
 * pass only wins outright when it has a *visible* match — the same criterion
 * {@link flowSelectorToFrame} uses to fall through — so `await`/`assert` and
 * `tap`/`type` resolve a bare string to the same element. A pass whose matches
 * are all zero-area is kept only as a last resort (so `exists`, which
 * deliberately accepts zero-area nodes, still sees them) instead of blocking
 * the text pass from finding the visible element.
 */
function flowFindAll(tree: DescribeNode, sel: FlowSelector): DescribeNode[] {
  let fallback: DescribeNode[] = [];
  for (const s of selectorAlternatives(sel)) {
    const matches = findAll(tree, s);
    if (matches.some(isVisible)) return matches;
    if (fallback.length === 0) fallback = matches;
  }
  return fallback;
}

/** Identifier-first-then-text frame resolution for a (possibly loose) selector. */
function flowSelectorToFrame(tree: DescribeNode, sel: FlowSelector): DescribeFrame | undefined {
  for (const s of selectorAlternatives(sel)) {
    const frame = selectorToFrame(tree, s);
    if (frame) return frame;
  }
  return undefined;
}

/** Outcome of {@link settleTree}: the tree plus whether it genuinely stopped. */
export interface SettleResult {
  tree: DescribeNode;
  /**
   * True when the requested settle phases stabilized: the tree in tree-only
   * mode, or the tree plus any available pixels in combined mode. False when
   * a deadline hit first (`tree` is then the best-effort last read).
   */
  converged: boolean;
  /**
   * True only when `tree` is safe to use for selector coordinates. A
   * best-effort combined result can outlive the last successful read when a
   * capture or final tree read consumes the deadline; acting callers must
   * reject it.
   */
  treeFresh: boolean;
  /**
   * Pixel phase outcome. `skipped` means tree-only mode, or that tree settling
   * exhausted its deadline before a combined settle could start captures.
   * Aborts return `undefined` from settleTree instead of a result.
   */
  visual: Exclude<PixelSettleOutcome, "aborted"> | "skipped";
}

export type SettleMode = "combined" | "tree-only";

export interface SettleOptions {
  /** Combined tree + pixel stabilization by default; tree-only skips captures. */
  mode?: SettleMode;
  /** Optional caller deadline, further bounded by the selected settle mode. */
  absoluteDeadline?: number;
}

type PixelCaptureResult = Awaited<ReturnType<typeof capturePixels>> | "deadline" | "aborted";
type TreeReadResult =
  | { type: "tree"; tree: DescribeNode }
  | { type: "error"; error: Error }
  | { type: "deadline" }
  | { type: "aborted" };

function treeSourceOutage(lastError?: Error): FlowTreeSourceUnavailableError {
  return new FlowTreeSourceUnavailableError(
    lastError ?? new Error("timed out reading the UI tree while settling")
  );
}

/** Run one tree read inside the same hard boundary as the rest of settling. */
async function fetchTreeBefore(env: ActionEnv, deadline: number): Promise<TreeReadResult> {
  if (env.signal?.aborted) return { type: "aborted" };
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { type: "deadline" };
  // Preserve the original Error object (and any structured failure metadata)
  // while still ensuring a late rejection is consumed after our wait ends.
  const pending = fetchFlowTree(env.registry, env.device).then(
    ({ tree }) => ({ type: "tree", tree }) as const,
    (err) =>
      ({
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      }) as const
  );
  const result = await settleWithin(pending, remaining, env.signal);
  if (result.type === "aborted" || env.signal?.aborted) return { type: "aborted" };
  if (result.type === "timeout") return { type: "deadline" };
  // `pending` resolves both its success and failure arms, but retain a safe
  // fallback if that wrapper changes later.
  if (result.type === "error") return { type: "error", error: new Error(result.error) };
  return result.value;
}

/**
 * Bound a screenshot read by the settle deadline. The capture itself may not
 * be cancellable (notably Chromium/CDP), so only our wait is raced. The
 * underlying {@link capturePixels} promise remains responsible for decoding
 * and deleting its temporary file when it eventually completes; settleWithin
 * also consumes a late rejection.
 */
async function capturePixelsBefore(env: ActionEnv, deadline: number): Promise<PixelCaptureResult> {
  if (env.signal?.aborted) return "aborted";
  const remaining = deadline - Date.now();
  if (remaining <= 0) return "deadline";
  const result = await settleWithin(capturePixels(env), remaining, env.signal);
  if (result.type === "aborted" || env.signal?.aborted) return "aborted";
  if (result.type === "timeout") return "deadline";
  // capturePixels is deliberately soft-failing, but keep that contract even if
  // a future implementation lets an error escape.
  if (result.type === "error") return undefined;
  return result.value;
}

/**
 * The single auto-settle primitive for flow interactions and snapshots.
 *
 * First, re-read the describe tree until two consecutive fingerprints match.
 * In `combined` mode (the default), then wait for two matching pixel captures
 * when screenshots are available and re-read the tree once more. If that final
 * tree moved during the pixel wait, restart from it instead of handing a stale
 * frame to the caller. `tree-only` mode returns after the matching tree pair
 * and never attempts a pixel capture.
 *
 * Returns the fully stable tree (`converged: true`), the best-effort latest tree
 * when either phase exhausts its bounded budget (`converged: false`), or
 * undefined if the run was aborted. `treeFresh` independently records whether
 * the returned selector coordinates are current (including the mandatory
 * post-pixel read in combined mode).
 * Screenshot unavailability is a soft fallback to tree-only settling, but is
 * still followed by that final tree read because even a failed capture may
 * have taken long enough for the model tree to move.
 *
 * Throws when EVERY read in the window failed: that is a tree-source outage
 * (e.g. native devtools disconnected mid-run — `fetchFlowTree` refuses to
 * degrade to a trimmed tree), not a mid-animation blip, and swallowing it would
 * convert the outage into a misleading "element not found" downstream. The
 * throw lands in the step's structured report via `execLeafStep`'s catch.
 */
export async function settleTree(
  env: ActionEnv,
  options: SettleOptions = {}
): Promise<SettleResult | undefined> {
  const mode = options.mode ?? "combined";
  const settleTimeout = mode === "combined" ? COMBINED_SETTLE_TIMEOUT_MS : SETTLE_TIMEOUT_MS;
  const deadline = Math.min(
    options.absoluteDeadline ?? Number.POSITIVE_INFINITY,
    Date.now() + settleTimeout
  );
  let seedFp: string | undefined;
  let lastTree: DescribeNode | undefined;
  let lastError: Error | undefined;
  // Freshness is independent of convergence. Every successful read makes the
  // returned tree current at that instant; only starting a pixel attempt makes
  // it unsafe again until a post-pixel read succeeds.
  let treeFresh = false;
  // A timeout remains best-effort across a tree restart unless a later pixel
  // phase actually observes a matching pair. Merely losing the capture backend
  // on the retry cannot retroactively turn timed-out pixels into convergence.
  let pixelsTimedOut = false;
  // Once the capture backend reports itself unavailable, finish any required
  // tree restart without probing it again. This preserves the original
  // tree-only soft fallback while still revalidating after the failed attempt.
  let pixelsUnavailable = false;
  let visual: SettleResult["visual"] = "skipped";

  for (;;) {
    const treeDeadline = Math.min(deadline, Date.now() + SETTLE_TIMEOUT_MS);
    let prevFp = seedFp;
    let stableTree: DescribeNode | undefined;
    let stableFp: string | undefined;

    // Tree phase: find two matching successful reads. A failed read stays a
    // transient gap, preserving the previous successful fingerprint exactly as
    // the original tree-only settle did.
    for (;;) {
      if (env.signal?.aborted) return undefined;
      const reading = await fetchTreeBefore(env, treeDeadline);
      if (reading.type === "aborted") return undefined;
      if (reading.type === "deadline") {
        if (lastTree === undefined) {
          throw treeSourceOutage(lastError);
        }
        return { tree: lastTree, converged: false, treeFresh, visual };
      }
      if (reading.type === "error") {
        lastError = reading.error;
      } else {
        const fp = treeFingerprint(reading.tree);
        lastTree = reading.tree;
        treeFresh = true;
        if (prevFp !== undefined && fp === prevFp) {
          stableTree = reading.tree;
          stableFp = fp;
          break;
        }
        prevFp = fp;
      }
      if (Date.now() >= treeDeadline) {
        if (lastTree === undefined) throw treeSourceOutage(lastError);
        return lastTree === undefined
          ? undefined
          : { tree: lastTree, converged: false, treeFresh, visual };
      }
      const sleepMs = Math.min(SETTLE_POLL_MS, Math.max(0, treeDeadline - Date.now()));
      if (!(await sleepOrAbort(sleepMs, env.signal))) return undefined;
    }

    if (mode === "tree-only" || pixelsUnavailable) {
      return { tree: stableTree, converged: !pixelsTimedOut, treeFresh: true, visual };
    }

    // Pixel phase. Every outcome flows to the final tree read below: even the
    // first capture can fail only after a long backend timeout, during which
    // the UI tree may have moved. Reserve a short slice of the hard outer
    // deadline so a hung capture cannot consume the only chance to revalidate.
    const pixelDeadline = Math.min(
      deadline - FINAL_TREE_REVALIDATE_RESERVE_MS,
      Date.now() + PIXEL_SETTLE_TIMEOUT_MS
    );
    let pixelsConverged = true;
    treeFresh = false;
    const firstPixels = await capturePixelsBefore(env, pixelDeadline);
    if (firstPixels === "aborted") return undefined;
    if (firstPixels === "deadline") {
      pixelsConverged = false;
      pixelsTimedOut = true;
      visual = "timed-out";
    } else if (firstPixels === undefined) {
      pixelsUnavailable = true;
      visual = "unavailable";
    } else {
      let prevPixels = firstPixels;
      for (;;) {
        const sleepMs = Math.min(PIXEL_SETTLE_POLL_MS, Math.max(0, pixelDeadline - Date.now()));
        if (sleepMs <= 0) {
          pixelsConverged = false;
          pixelsTimedOut = true;
          visual = "timed-out";
          break;
        }
        if (!(await sleepOrAbort(sleepMs, env.signal))) return undefined;
        const nextPixels = await capturePixelsBefore(env, pixelDeadline);
        if (nextPixels === "aborted") return undefined;
        if (nextPixels === "deadline") {
          pixelsConverged = false;
          pixelsTimedOut = true;
          visual = "timed-out";
          break;
        }
        if (nextPixels === undefined) {
          pixelsUnavailable = true;
          visual = "unavailable";
          break;
        }
        if (!pixelsDiffer(prevPixels, nextPixels)) {
          pixelsTimedOut = false;
          visual = "settled";
          break;
        }
        prevPixels = nextPixels;
      }
    }

    // Revalidate after every pixel attempt, including a slow first capture that
    // returned undefined and all timeout paths. If this read cannot complete,
    // retain the best-effort tree for diagnostics/snapshots but mark it unsafe
    // for any caller that would derive gesture coordinates from it.
    const finalReading = await fetchTreeBefore(env, deadline);
    if (finalReading.type === "aborted") return undefined;
    if (finalReading.type === "deadline") {
      return { tree: lastTree ?? stableTree, converged: false, treeFresh: false, visual };
    }
    if (finalReading.type === "tree") {
      lastTree = finalReading.tree;
      treeFresh = true;
      const finalFp = treeFingerprint(finalReading.tree);
      if (finalFp === stableFp) {
        return {
          tree: finalReading.tree,
          converged: pixelsConverged && !pixelsTimedOut,
          treeFresh: true,
          visual,
        };
      }
      // The model tree moved while pixels were being observed. Treat this
      // fresh read as the first sample of the next tree phase.
      seedFp = finalFp;
    } else {
      lastError = finalReading.error;
      seedFp = stableFp;
    }

    if (Date.now() >= deadline) {
      return { tree: lastTree ?? stableTree, converged: false, treeFresh, visual };
    }
  }
}

/**
 * Poll until a visible element matches the selector, resolving against a
 * *settled* tree each round so the returned frame is stable. Returns the frame,
 * undefined once the deadline passes, or "aborted" when the run was cancelled —
 * the two misses must stay distinguishable, or a cancelled `tap`/`type` would
 * be reported as a genuine "element not found" failure.
 *
 * `settleTree` owns both tree and pixel stabilization and revalidates the tree
 * after the pixel wait, so selector resolution never uses a pre-transition
 * frame.
 */
async function waitForFrame(
  env: ActionEnv,
  selector: FlowSelector
): Promise<DescribeFrame | "aborted" | undefined> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  for (;;) {
    if (env.signal?.aborted) return "aborted";
    if (Date.now() >= deadline) return undefined;
    const settled = await settleTree(env, { absoluteDeadline: deadline });
    if (settled?.treeFresh) {
      const frame = flowSelectorToFrame(settled.tree, selector);
      if (frame) return frame;
    } else if (env.signal?.aborted) {
      return "aborted"; // settleTree bailed on the abort, not on a blank read
    }
    if (Date.now() >= deadline) return undefined;
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) return "aborted";
  }
}

function framesOverlap(a: DescribeFrame, b: DescribeFrame): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Is this node a scroll container? Android's uiautomator dump flags one
 * directly (`scrollable`); the iOS full-hierarchy adapter carries no such flag
 * but maps UIScrollView/UITableView/UICollectionView class names to the
 * AXScrollArea role, which the role test catches. The Chromium DOM walker sets
 * `scrollable` on overflow scrollers too, but the flow adapter
 * (`projectChromiumNode`) only emits leaves that are otherwise addressable
 * (identifier/label/value/clickable/focused) — an ANONYMOUS overflow scroller
 * never reaches the flow tree, so on Chromium only addressable scrollers are
 * detected here and the caller falls back to the whole screen otherwise.
 */
function isScrollContainer(node: DescribeNode): boolean {
  return node.scrollable === true || /scroll/i.test(node.role);
}

/**
 * Frames of every visible scroll container whose frame contains the swipe
 * anchor. The OS routes a scroll gesture to a scroller hit-tested at the
 * anchor, so the container that will actually move is always among these. ALL
 * of them are returned rather than just the innermost: the innermost may not
 * scroll along the requested axis at all (a horizontal carousel under a
 * vertical swipe hands the gesture to an ancestor), and an end-of-scroll
 * fingerprint scoped to it alone would misread the outer scroller's real
 * progress as "stuck". Empty when the tree surfaces no scroll container at the
 * anchor (e.g. a page-level scroller the source doesn't emit as a node).
 */
function anchorScrollFrames(tree: DescribeNode, anchor: { x: number; y: number }): DescribeFrame[] {
  const frames: DescribeFrame[] = [];
  const walk = (node: DescribeNode): void => {
    if (
      isScrollContainer(node) &&
      isVisible(node) &&
      frameContains(node.frame, anchor.x, anchor.y)
    ) {
      frames.push(node.frame);
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return frames;
}

function collectFocused(node: DescribeNode, acc: DescribeNode[]): DescribeNode[] {
  if (node.focused) acc.push(node);
  for (const child of node.children) collectFocused(child, acc);
  return acc;
}

/**
 * Poll until an element reporting `focused` overlaps the typed-into element.
 * Overlap, not identity: the selector often matches a testID container while
 * focus is reported by the input inside it. The target's frame is re-resolved
 * each round — the keyboard sliding up routinely scrolls the field away from
 * where it was tapped (keyboard avoidance), and the focused element must be
 * compared against where the field is NOW; `tappedFrame` covers rounds where
 * the selector momentarily doesn't resolve. Best-effort by design — a source
 * that can't report focus returns immediately, and an unconfirmed poll falls
 * through to typing after the timeout rather than failing the step, since "no
 * focus seen" can also mean the focused view didn't make it into the tree.
 */
async function waitForFocus(
  env: ActionEnv,
  into: FlowSelector,
  tappedFrame: DescribeFrame
): Promise<void> {
  const deadline = Date.now() + TYPE_FOCUS_TIMEOUT_MS;
  for (;;) {
    if (env.signal?.aborted) return;
    try {
      const { tree, source } = await fetchFlowTree(env.registry, env.device);
      if (!FOCUS_REPORTING_SOURCES.has(source)) return;
      const target = flowSelectorToFrame(tree, into) ?? tappedFrame;
      if (collectFocused(tree, []).some((n) => framesOverlap(n.frame, target))) return;
    } catch {
      // transient describe failure — retry until the deadline
    }
    if (Date.now() >= deadline) return;
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) return;
  }
}

interface ScrollResolve {
  /** The target's frame once it became visible. */
  frame?: DescribeFrame;
  /** Why the scroll stopped without finding the target. */
  reason?: string;
  /** The run was cancelled mid-scroll. */
  aborted?: boolean;
}

/**
 * Dispatch one momentum-free scroll increment anchored at the center of
 * `region`. The anchor (the touch-down / wheel point) is what selects the scroll
 * container — the OS routes the gesture to the innermost scroller hit-tested
 * there — so anchoring inside a `within` region is how nested scrollers are
 * disambiguated. The travel is half the region along the axis (only the end
 * point is clamped, so the down stays at the anchor and keeps latching to the
 * right container) — sized to the clip window rather than the screen, so
 * consecutive views of a small container's content still overlap and a target
 * can't be scrolled fully past between settle checkpoints. Touch platforms use
 * a `settle` swipe (no fling); Chromium uses wheel events (already
 * momentum-free).
 */
async function scrollIncrement(
  env: ActionEnv,
  direction: ScrollDirection,
  region: DescribeFrame
): Promise<void> {
  const cx = clamp01(region.x + region.width / 2);
  const cy = clamp01(region.y + region.height / 2);
  const extent = direction === "up" || direction === "down" ? region.height : region.width;
  const dist = Math.min(SCROLL_INCREMENT, Math.max(MIN_SCROLL_INCREMENT, extent / 2));

  if (env.device.platform === "chromium") {
    // Positive deltaY/deltaX reveals content below / to the right (see gesture-scroll).
    const delta =
      direction === "down"
        ? { deltaY: dist }
        : direction === "up"
          ? { deltaY: -dist }
          : direction === "right"
            ? { deltaX: dist }
            : { deltaX: -dist };
    await invokeOnDevice(env, "gesture-scroll", { x: cx, y: cy, ...delta });
    return;
  }

  // To reveal content below the fold the finger travels UP (toY < fromY), etc.
  let to: { x: number; y: number };
  switch (direction) {
    case "down":
      to = { x: cx, y: clamp01(cy - dist) };
      break;
    case "up":
      to = { x: cx, y: clamp01(cy + dist) };
      break;
    case "right":
      to = { x: clamp01(cx - dist), y: cy };
      break;
    case "left":
      to = { x: clamp01(cx + dist), y: cy };
      break;
  }
  await invokeOnDevice(env, "gesture-swipe", {
    fromX: cx,
    fromY: cy,
    toX: to.x,
    toY: to.y,
    settle: true,
    durationMs: 600,
  });
}

/**
 * Scroll until `target` is as visible as it can get within the scroll viewport
 * along the scroll axis — fully inside it, or (for a target as tall/wide as the
 * viewport or larger) spanning it — returning its frame. Before the first
 * decision it performs a combined tree + pixel settle so scrolling never
 * starts through an unrelated transition. Later rounds settle only the tree:
 * every increment is momentum-free/settled, and a following tap/type/snapshot
 * performs its own visual settle. Each round then checks the target and, if it
 * isn't fully in view, does one increment. Stopping only once the target has
 * cleared the entry edge (not on the first sliver) is what keeps a following
 * `tap`/`snapshot` off a half-clipped element. If a
 * round's settled tree — fingerprinted within the scrolled region only (the
 * `within` container, or the scroll containers under the gesture anchor when
 * none is named) — is identical to the previous round's, the container has hit
 * its end (or the anchor scrolls nothing): the target is then as visible as it
 * will ever be, so it's accepted wherever it landed — the LAST item sits flush
 * against the far edge and can never clear it, and a genuinely stuck partial
 * can't be improved either. A target already fully on screen returns
 * immediately (no scroll).
 */
async function scrollToVisible(
  env: ActionEnv,
  target: FlowSelector,
  direction: ScrollDirection,
  within: FlowSelector | undefined
): Promise<ScrollResolve> {
  let prevFp: string | undefined;
  for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
    if (env.signal?.aborted) return { aborted: true };

    const settled = await settleTree(env, { mode: i === 0 ? "combined" : "tree-only" });
    if (!settled) return { aborted: true }; // settleTree only returns undefined on abort
    if (!settled.treeFresh) {
      return { reason: "timed out revalidating the UI tree after visual settling" };
    }
    const tree = settled.tree;

    // Anchor the gesture inside the container (so the right nested scroller
    // moves), or over the whole screen when none is named. Its frame is also the
    // clip window the axis check measures the target against.
    const region = within ? flowSelectorToFrame(tree, within) : FULL_SCREEN;
    if (!region) {
      return { reason: `scroll container ${describeSelector(within!)} is not visible` };
    }

    const frame = flowSelectorToFrame(tree, target);
    if (frame && axisFullyInside(frame, direction, region)) return { frame };

    // Fingerprint only the scrolled content: a continuously-animating node
    // outside it (a spinner, a ticking clock) would keep a wider fingerprint
    // changing on every read, so a container that stopped moving would never
    // read as "end of scroll" and the loop would burn all its iterations. The
    // scope is the `within` container's region when one is named; otherwise the
    // gesture anchors at the screen centre and the OS routes it to a scroller
    // hit-tested there, so the scope is every visible scroll container under
    // that anchor (their union — not the innermost; see anchorScrollFrames).
    // Only when the tree surfaces no scroll container at the anchor does the
    // scope stay the whole screen — a screen-level animator can then still mask
    // end-of-scroll, and the loop falls back to the iteration cap. Text stays
    // in the fingerprint for in-scope nodes — a snapping list recycles
    // identical frames with new content, so structure alone would misread real
    // progress as a stuck scroll — which also means an animating node INSIDE
    // the scrolled content remains a known limitation.
    const scope = within ? [region] : anchorScrollFrames(tree, getDescribeTapPoint(region));
    if (scope.length === 0) scope.push(FULL_SCREEN);
    const fp = treeFingerprint(tree, (node) => scope.some((r) => framesOverlap(node.frame, r)));
    if (prevFp !== undefined && fp === prevFp) {
      // End of the scroll — accept the target wherever it landed (best effort).
      if (frame) return { frame };
      return {
        reason: `reached the end of the scroll without finding ${describeSelector(target)}`,
      };
    }
    prevFp = fp;

    await scrollIncrement(env, direction, region);
  }
  return {
    reason: `${describeSelector(target)} not found after ${MAX_SCROLL_ITERATIONS} scroll attempts`,
  };
}

// `tap`/`type` auto-wait but deliberately do NOT auto-scroll: an implicit
// scroll would widen a loose selector's match scope from the viewport to the
// whole page, mutate scroll state even when the step fails, and stretch a
// failure to the scroll search's worst case. Off-screen targets take an
// explicit `scroll-to` step — the failure reason points there.
function offscreenHint(sel: FlowSelector): string {
  return `no visible element matched selector ${describeSelector(sel)} — if it is off-screen, add a scroll-to step before this one`;
}

/** Execute one selector-acting directive (`tap` / `long-press` / `type` / `await` / `assert` / `scroll-to` / `pinch`). */
export async function runDirective(env: ActionEnv, step: DirectiveStep): Promise<DirectiveOutcome> {
  // Vega is remote-driven — there is no touch input, so the touch directives
  // can never act on it. Fail upfront with authoring guidance instead of a
  // low-level gesture dispatch error after the selector resolves.
  if (
    env.device.platform === "vega" &&
    (step.kind === "tap" ||
      step.kind === "long-press" ||
      step.kind === "type" ||
      step.kind === "scroll-to" ||
      step.kind === "pinch")
  ) {
    return {
      ok: false,
      reason: `${step.kind} is a touch directive and Vega is remote-driven — move focus with \`tool: tv-remote\` steps (and type via \`tool: keyboard\`) instead`,
    };
  }
  // Chromium: not "no backend" — CDP can dispatch two-finger touch, but a
  // mouse-driven desktop app has no uniform pinch-zoom mapping for it to hit.
  if (step.kind === "pinch" && env.device.platform === "chromium") {
    return {
      ok: false,
      reason:
        "pinch is unsupported on chromium — desktop apps have no uniform pinch-zoom mapping (they zoom via ctrl+wheel or their own controls); drive the app's zoom UI with tap/keyboard instead",
    };
  }
  switch (step.kind) {
    case "tap":
      return runTap(env, step);
    case "long-press":
      return runLongPress(env, step);
    case "type":
      return runType(env, step);
    case "await":
      return waitForCondition(env, step, step.timeout ?? DEFAULT_ACTION_TIMEOUT_MS);
    case "assert":
      return waitForCondition(env, step, DEFAULT_ASSERT_TIMEOUT_MS);
    case "scroll-to": {
      const r = await scrollToVisible(env, step.target, step.direction, step.within);
      if (r.aborted) return ABORTED_OUTCOME;
      return { ok: Boolean(r.frame), reason: r.reason };
    }
    case "pinch":
      return runPinch(env, step);
  }
}

/**
 * Resolve a gesture target (`tap`/`long-press`) to a normalized point: a
 * selector resolves to its frame centre (settled tree + auto-wait); raw
 * coordinates still wait for the same combined settle before dispatch.
 * Coordinate targets are the fallback for elements with no stable selector
 * (e.g. an unlabeled view), not an escape hatch from full-hierarchy settling:
 * they bypass selector resolution only, and still require the platform's flow
 * tree/devtools source to be available.
 */
async function resolveTargetPoint(
  env: ActionEnv,
  target: { selector?: FlowSelector; x?: number; y?: number }
): Promise<{ x: number; y: number } | { fail: DirectiveOutcome }> {
  if (target.selector) {
    const frame = await waitForFrame(env, target.selector);
    if (frame === "aborted") return { fail: ABORTED_OUTCOME };
    if (!frame) {
      return { fail: { ok: false, reason: offscreenHint(target.selector) } };
    }
    return getDescribeTapPoint(frame);
  }
  if (typeof target.x === "number" && typeof target.y === "number") {
    const settled = await settleTree(env, {
      absoluteDeadline: Date.now() + DEFAULT_ACTION_TIMEOUT_MS,
    });
    if (!settled) return { fail: ABORTED_OUTCOME };
    if (!settled.treeFresh) {
      return {
        fail: { ok: false, reason: "timed out revalidating the UI tree after visual settling" },
      };
    }
    return { x: target.x, y: target.y };
  }
  return { fail: { ok: false, reason: "gesture needs a selector or x/y coordinates" } };
}

/**
 * Tap a resolved target point. `times` rides the gesture-tap tool's
 * `clickCount`: one resolution, one dispatched multi-tap gesture — never N
 * separate calls, whose RPC gaps could fall outside the OS double-tap window.
 */
async function runTap(
  env: ActionEnv,
  target: { selector?: FlowSelector; x?: number; y?: number; times?: number }
): Promise<DirectiveOutcome> {
  const point = await resolveTargetPoint(env, target);
  if ("fail" in point) return point.fail;
  await invokeOnDevice(env, "gesture-tap", {
    ...point,
    ...(target.times !== undefined ? { clickCount: target.times } : {}),
  });
  return { ok: true };
}

/**
 * Long-press defaults comfortably past both platforms' recognizers — iOS
 * UILongPressGestureRecognizer's 500ms minimum and Android's ~400ms
 * long-press timeout (RN's Pressable uses 500ms) — without dragging every
 * step out.
 */
const DEFAULT_LONG_PRESS_MS = 800;

/**
 * Press-and-hold on a target (same resolution as tap: selector → frame
 * centre, or a raw point) for `duration` ms. Touch platforms dispatch ONE
 * `gesture-custom` train (Down, then Up delayed by the duration) so the hold
 * length is exact; Chromium has no touch, so the closest honest mapping is a
 * mouse press-hold-release (`gesture-drag` with from == to) — apps
 * implementing pointer-based long-press respond, anything else sees a slow
 * click. A desktop context menu is a *right*-click, deliberately not aliased
 * here.
 */
async function runLongPress(
  env: ActionEnv,
  step: { selector?: FlowSelector; x?: number; y?: number; duration?: number }
): Promise<DirectiveOutcome> {
  const point = await resolveTargetPoint(env, step);
  if ("fail" in point) return point.fail;
  const duration = step.duration ?? DEFAULT_LONG_PRESS_MS;
  if (env.device.platform === "chromium") {
    await invokeOnDevice(env, "gesture-drag", {
      fromX: point.x,
      fromY: point.y,
      toX: point.x,
      toY: point.y,
      durationMs: duration,
    });
  } else {
    await invokeOnDevice(env, "gesture-custom", {
      events: [
        { type: "Down", x: point.x, y: point.y, delayMs: 0 },
        { type: "Up", x: point.x, y: point.y, delayMs: duration },
      ],
    });
  }
  return { ok: true };
}

/**
 * Pinch-zoom by `scale` centered on a selector's frame (settled tree +
 * auto-wait, like tap) or on the screen center when no selector is given. The
 * scale decomposes into equal-ratio sub-gestures chained with a recognizer
 * reset delay; per sub-gesture, a horizontal and a vertical candidate are
 * built from the axis-matching frame dimension and the better one dispatched
 * (see flow-pinch-geometry). Open-loop by design: there is no "current zoom"
 * to read back, so flows assert on the result, not the multiplier.
 */
async function runPinch(
  env: ActionEnv,
  step: { selector?: FlowSelector; scale: number }
): Promise<DirectiveOutcome> {
  let center = { x: 0.5, y: 0.5 };
  let frame: DescribeFrame | undefined;
  if (step.selector) {
    const resolved = await waitForFrame(env, step.selector);
    if (resolved === "aborted") return ABORTED_OUTCOME;
    if (!resolved) return { ok: false, reason: offscreenHint(step.selector) };
    frame = resolved;
    center = getDescribeTapPoint(resolved);
  }

  const { n, per } = decomposePinch(step.scale);
  // Guards are resolved exactly once per directive; geometry only ever
  // receives them as data (the seam for a future per-device query).
  const guards = systemEdgeGuards(env.device);
  const candidates = [
    buildAxisCandidate({ angle: 0, center, targetSpan: frame?.width, per, guards }),
    buildAxisCandidate({ angle: 90, center, targetSpan: frame?.height, per, guards }),
  ].filter((c): c is PinchCandidate => c !== undefined);
  const selected = selectPinchCandidate(candidates);
  if (!selected) {
    // The only geometry failure: literally no room to move the fingers —
    // never "target too small" (a tiny target is still attempted).
    return {
      ok: false,
      reason: `pinch found no on-screen finger travel around (${center.x}, ${center.y})`,
    };
  }

  const args: Record<string, unknown> = {
    centerX: center.x,
    centerY: center.y,
    startDistance: selected.start,
    endDistance: selected.end,
    angle: selected.angle,
  };
  // Centroid drift rides the gesture only on the moving axis, and only when
  // the clamp actually moved it.
  const startCenter = selected.angle === 0 ? center.x : center.y;
  if (selected.endCenter !== startCenter) {
    args[selected.angle === 0 ? "endCenterX" : "endCenterY"] = selected.endCenter;
  }

  for (let i = 0; i < n; i++) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    await invokeOnDevice(env, "gesture-pinch", args);
    if (i < n - 1 && !(await sleepOrAbort(PINCH_SETTLE_MS, env.signal))) return ABORTED_OUTCOME;
  }
  return { ok: true };
}

/**
 * Resolve `into` → tap to focus → wait for focus to land → type text via the
 * keyboard tool. Unless `submit` is explicitly `false`, a trailing Enter is
 * pressed to commit the value and dismiss the keyboard, so it can't obscure
 * later steps (chained form fields that end in an explicit submit `tap` should
 * pass `submit: false`).
 */
async function runType(
  env: ActionEnv,
  step: { into: FlowSelector; text: string; submit?: boolean }
): Promise<DirectiveOutcome> {
  const frame = await waitForFrame(env, step.into);
  if (frame === "aborted") return ABORTED_OUTCOME;
  if (!frame) {
    return { ok: false, reason: offscreenHint(step.into) };
  }
  await invokeOnDevice(env, "gesture-tap", getDescribeTapPoint(frame));
  // Keys are injected at the HID level and go to whatever holds focus, so the
  // tap→type gap must cover the app's focus round-trip (see the constants).
  if (!(await sleepOrAbort(TYPE_FOCUS_SETTLE_MS, env.signal))) {
    return ABORTED_OUTCOME;
  }
  await waitForFocus(env, step.into, frame);
  // waitForFocus returns void on abort as well as on focus/timeout — re-check
  // before every keyboard dispatch (the keyboard tool has no abort handling of
  // its own), so a cancelled run can never type into, or submit, whatever the
  // app has focused after the caller gave up.
  if (env.signal?.aborted) return ABORTED_OUTCOME;
  await invokeOnDevice(env, "keyboard", { text: step.text });
  if (step.submit !== false) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    // Press Enter as a separate keyboard call — the tool dispatches `key`
    // before `text`, so a combined `{ text, key }` would submit before typing.
    await invokeOnDevice(env, "keyboard", { key: "enter" });
  }
  return { ok: true };
}

/**
 * Poll a condition against the flow tree until it holds or `timeoutMs` passes.
 * One engine behind both conditional directives — they differ only in budget
 * and intent:
 *
 * - `await` (action-length default timeout, overridable per step via
 *   `timeout:`) — a real wait for a transition. Evaluating it here, rather
 *   than delegating to the `await-ui-element` tool, gives it the same loose
 *   bare-string semantics (identifier-first, then text) and the same
 *   full-hierarchy tree source as every other selector directive; the raw
 *   `tool: await-ui-element` step remains the escape hatch for custom
 *   poll/bundleId.
 * - `assert` (short grace window, {@link DEFAULT_ASSERT_TIMEOUT_MS}) — a
 *   correctness check that only absorbs the latency of an update landing a
 *   frame after an action; a genuinely-false assertion still fails quickly.
 *
 * Mirrors `await-ui-element`'s blind-read guard: an EMPTY tree is not
 * trustworthy evidence for `hidden` (the only condition an empty tree
 * satisfies) when the adapter flagged the read as degraded or the selector had
 * matched on an earlier poll — a transient blank frame mid-navigation must not
 * confirm the element left.
 */
async function waitForCondition(
  env: ActionEnv,
  step: {
    condition: WaitCondition;
    selector: FlowSelector;
    expectedText?: string;
    textMatch?: TextMatchMode;
  },
  timeoutMs: number
): Promise<DirectiveOutcome> {
  const deadline = Date.now() + timeoutMs;

  let lastMatches: ReturnType<typeof findAll> = [];
  let fetchError: string | undefined;
  let everMatched = false;
  // Date.now() of the most recent TRUSTED read — undefined until one lands.
  // Post-loop it anchors the dark-tail measurement: how long the window's
  // final stretch went without a trustworthy look at the screen.
  let lastTrustedReadAt: number | undefined;
  // Whether the LAST completed read attempt was trusted — assigned on every
  // pass through the loop (true on a trusted fetch, false on a blind one or a
  // throw), so post-loop it describes the final poll.
  let lastReadTrusted: boolean;
  let finalPoll = false;

  for (;;) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    try {
      const data = await fetchFlowTree(env.registry, env.device);
      lastMatches = flowFindAll(data.tree, step.selector);
      fetchError = undefined;
      everMatched ||= lastMatches.length > 0;
      const blind =
        data.tree.children.length === 0 && Boolean(data.hint || data.should_restart || everMatched);
      if (!blind) lastTrustedReadAt = Date.now();
      lastReadTrusted = !blind;
      if (
        !blind &&
        evaluateCondition(step.condition, step.expectedText, lastMatches, step.textMatch)
      ) {
        return { ok: true };
      }
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
      // A throw is as blind as an empty tree — `lastMatches` still holds the
      // previous successful read, which must not pass for current evidence.
      lastReadTrusted = false;
    }
    if (Date.now() >= deadline) {
      if (finalPoll) break;
      finalPoll = true;
      continue;
    }
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) {
      return ABORTED_OUTCOME;
    }
  }

  // Post-timeout verdict — unknown must not masquerade as false. Three tiers
  // of evidence quality:
  //
  // 1. No trusted read in the whole window: every fetch either threw or
  //    returned a blind tree (empty + degraded hint, or empty after the
  //    selector had matched). A probe that never got a trustworthy look at
  //    the screen cannot vouch for "condition false" for ANY condition.
  // 2. Trusted reads existed but the window went dark at the end: the FINAL
  //    read attempt was blind or threw AND the last trusted read lies more
  //    than {@link CONDITION_DARK_TAIL_TOLERANCE_MS} behind the loop's exit.
  //    The condition becoming true is exactly the transition being waited on,
  //    so a "condition false" observation from before the reads went dark
  //    says nothing about the deadline — a determinate verdict built from it
  //    would let a dying tree source fake a clean report (and green-skip a
  //    `when:` guard whose dismissal target may well be on screen). `hidden`
  //    is held to a stricter bar: there "condition false" means the element
  //    was VISIBLE, and the element leaving is the transition itself — so ANY
  //    untrusted final read, however short the tail, leaves gone-ness
  //    unconfirmable.
  // 3. Dark tail within the tolerance — a genuine last-poll blip: trusted
  //    reads showed the condition false until at most ~one poll interval
  //    before the deadline, so they still describe the window and a transient
  //    fetch error on the trailing poll must not flip a clean skip into a
  //    hard error. The determinate verdict stands, with the failed final read
  //    appended so the error is not silently dropped from the report.
  if (lastTrustedReadAt === undefined) {
    return {
      ok: false,
      indeterminate: true,
      reason: fetchError
        ? `could not read the UI tree: ${fetchError}`
        : "could not evaluate the condition — every read of the UI tree was empty or degraded",
    };
  }
  if (!lastReadTrusted) {
    // `hidden` with an evidence gap: the element matched on an earlier
    // trusted read and the FINAL read attempt was blind or threw, so
    // gone-ness can't be confirmed — no blip tolerance here (tier 2's
    // stricter bar). (A trusted read WITHOUT a visible match would have
    // satisfied `hidden` inside the loop, so a trusted final read implies it
    // saw the element — that falls through to the determinate "still
    // visible" below with `lastMatches` fresh from that read.)
    if (step.condition === "hidden") {
      return {
        ok: false,
        indeterminate: true,
        reason: fetchError
          ? `could not confirm the element is hidden — it was visible earlier, but the last UI read failed: ${fetchError}`
          : "could not confirm the element is hidden — it was visible earlier, but the last UI reads were empty",
      };
    }
    const darkTailMs = Date.now() - lastTrustedReadAt;
    if (darkTailMs > CONDITION_DARK_TAIL_TOLERANCE_MS) {
      return {
        ok: false,
        indeterminate: true,
        reason: fetchError
          ? `could not evaluate the condition — the UI tree was unreadable for the final ${darkTailMs}ms of the window: ${fetchError}`
          : `could not evaluate the condition — the UI tree reads were empty or degraded for the final ${darkTailMs}ms of the window`,
      };
    }
  }
  // Tier 3 (or a trusted final read): the verdict is determinate; a blip's
  // failed final read is appended, not dropped.
  const blipNote =
    !lastReadTrusted && fetchError
      ? ` (the final poll could not read the UI tree: ${fetchError})`
      : "";
  return {
    ok: false,
    reason:
      assertReason(step.condition, step.selector, step.expectedText, step.textMatch, lastMatches) +
      blipNote,
  };
}

function assertReason(
  condition: WaitCondition,
  selector: FlowSelector,
  expectedText: string | undefined,
  textMatch: TextMatchMode | undefined,
  matches: ReturnType<typeof findAll>
): string {
  const sel = describeSelector(selector);
  switch (condition) {
    case "exists":
      return `no element matched selector ${sel}`;
    case "visible":
      return matches.length > 0
        ? `element(s) matched ${sel} but none was visible (zero-area frame)`
        : `no element matched selector ${sel}`;
    case "hidden":
      // Reached only when the final read was trusted (waitForCondition
      // returns indeterminate when it was blind or threw), and a trusted read
      // without a visible match satisfies `hidden` inside the poll loop — so
      // `matches` holds what that read saw: the element, still on screen.
      return `an element matching ${sel} was still visible`;
    case "text": {
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      if (!first) return `no element matched selector ${sel}`;
      const wanted = describeTextExpectation(expectedText, textMatch, "infinitive");
      // The check accepts the element's own label/value as well as its hoisted
      // subtree text (see evaluateCondition), so when they differ quote both —
      // the author may have been asserting against either.
      const shown = assertText(first);
      const own = nodeText(first);
      const ownNote = own && own !== shown ? ` (own text "${own}")` : "";
      return `element matched ${sel} but its text was "${shown}"${ownNote} (wanted to ${wanted})`;
    }
    default:
      return `assertion failed for selector ${sel}`;
  }
}
