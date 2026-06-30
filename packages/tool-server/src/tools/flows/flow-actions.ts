import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { getDescribeTapPoint, type DescribeFrame, type DescribeNode } from "../describe/contract";
import {
  selectorToFrame,
  findAll,
  evaluateCondition,
  firstInReadingOrder,
  isVisible,
  nodeText,
  treeFingerprint,
  type Selector,
  type WaitCondition,
} from "../../utils/ui-tree-match";
import { sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import { bindDeviceArgs } from "./flow-device";
import { fetchFlowTree } from "./flow-native-tree";
import type { ScrollDirection } from "./flow-utils";

/** Outcome of a selector directive: ok, or a machine-readable reason it failed. */
export interface DirectiveOutcome {
  ok: boolean;
  reason?: string;
}

const DEFAULT_ACTION_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 300;

// Settle detection: re-read the tree until two consecutive reads match, so a tap
// never lands mid-fling and a resolved frame can't go stale before we act.
const SETTLE_POLL_MS = 150;
const SETTLE_TIMEOUT_MS = 3000;

// `scroll-to`: a bounded number of momentum-free increments. Each travels half a
// screen — large enough to register as a scroll (not a tap) and not depend on
// the container's size, yet < 1 viewport, so a target can never be skipped over
// between two settle checkpoints (consecutive viewports overlap).
const MAX_SCROLL_ITERATIONS = 25;
const SCROLL_INCREMENT = 0.5;

const FULL_SCREEN: DescribeFrame = { x: 0, y: 0, width: 1, height: 1 };

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// `assert` is a correctness check, not an open-ended wait — but UI updates after
// an action land asynchronously, so a strictly one-shot read races the
// re-render (e.g. a counter that increments a frame after a tap). Like
// Playwright's web-first assertions, assert retries for a short grace window so
// it absorbs that latency; a genuinely-false assertion still fails quickly.
const DEFAULT_ASSERT_TIMEOUT_MS = 500;

function describeSelector(s: Selector): string {
  return Object.entries(s)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
}

/**
 * Re-read the describe tree until two consecutive reads are identical — the UI
 * has settled (a scroll's fling has stopped, an animation finished). Returns the
 * stable tree, the last tree read on timeout (best effort), or undefined if the
 * run was aborted. Resolving a frame from a settled tree is what keeps a tap
 * from landing mid-deceleration (where a scroll view swallows it) or acting on a
 * frame that has already moved.
 */
async function settleTree(
  registry: Registry,
  device: DeviceInfo,
  signal?: AbortSignal
): Promise<DescribeNode | undefined> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let prevFp: string | undefined;
  let prevTree: DescribeNode | undefined;
  for (;;) {
    if (signal?.aborted) return undefined;
    try {
      const { tree } = await fetchFlowTree(registry, device);
      const fp = treeFingerprint(tree);
      if (prevFp !== undefined && fp === prevFp) return tree;
      prevFp = fp;
      prevTree = tree;
    } catch {
      // transient describe failure mid-navigation — retry until the deadline
    }
    if (Date.now() >= deadline) return prevTree;
    if (!(await sleepOrAbort(SETTLE_POLL_MS, signal))) return undefined;
  }
}

/**
 * Poll until a visible element matches the selector, resolving against a
 * *settled* tree each round so the returned frame is stable. Returns the frame,
 * or undefined if the deadline passes / the run is aborted.
 */
async function waitForFrame(
  registry: Registry,
  device: DeviceInfo,
  selector: Selector,
  signal?: AbortSignal
): Promise<DescribeFrame | undefined> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return undefined;
    const tree = await settleTree(registry, device, signal);
    if (tree) {
      const frame = selectorToFrame(tree, selector);
      if (frame) return frame;
    }
    if (Date.now() >= deadline) return undefined;
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, signal))) return undefined;
  }
}

interface ScrollResolve {
  /** The target's frame once it became visible. */
  frame?: DescribeFrame;
  /** Why the scroll stopped without finding the target. */
  reason?: string;
}

/**
 * Dispatch one momentum-free scroll increment anchored at the center of
 * `region`. The anchor (the touch-down / wheel point) is what selects the scroll
 * container — the OS routes the gesture to the innermost scroller hit-tested
 * there — so anchoring inside a `within` region is how nested scrollers are
 * disambiguated. The travel is a fixed half-screen along the axis (only the end
 * point is clamped, so the down stays at the anchor and keeps latching to the
 * right container). Touch platforms use a `settle` swipe (no fling); Chromium
 * uses wheel events (already momentum-free).
 */
async function scrollIncrement(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  direction: ScrollDirection,
  region: DescribeFrame
): Promise<void> {
  const cx = clamp01(region.x + region.width / 2);
  const cy = clamp01(region.y + region.height / 2);
  const dist = SCROLL_INCREMENT;

  if (device.platform === "chromium") {
    // Positive deltaY/deltaX reveals content below / to the right (see gesture-scroll).
    const delta =
      direction === "down"
        ? { deltaY: dist }
        : direction === "up"
          ? { deltaY: -dist }
          : direction === "right"
            ? { deltaX: dist }
            : { deltaX: -dist };
    await invokeSubTool(
      registry,
      ctx,
      "gesture-scroll",
      bindDeviceArgs(registry, "gesture-scroll", device.id, { x: cx, y: cy, ...delta })
    );
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
  await invokeSubTool(
    registry,
    ctx,
    "gesture-swipe",
    bindDeviceArgs(registry, "gesture-swipe", device.id, {
      fromX: cx,
      fromY: cy,
      toX: to.x,
      toY: to.y,
      settle: true,
    })
  );
}

/**
 * Scroll until `target` resolves to a visible frame, returning that frame.
 * Each round settles the tree, checks for the target, then — if absent — does
 * one momentum-free increment. If a round's settled tree is identical to the
 * previous round's, the container has hit its end (or the anchor scrolls
 * nothing), so it stops rather than looping. Per-increment distance need not be
 * exact: the loop re-checks after every step, so overshoot just means another
 * round, and a target already on screen returns immediately (no scroll).
 */
async function scrollToVisible(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  target: Selector,
  direction: ScrollDirection,
  within: Selector | undefined,
  signal?: AbortSignal
): Promise<ScrollResolve> {
  let prevFp: string | undefined;
  for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
    if (signal?.aborted) return { reason: "scroll cancelled" };

    const tree = await settleTree(registry, device, signal);
    if (!tree) return { reason: "scroll cancelled" };

    const frame = selectorToFrame(tree, target);
    if (frame) return { frame };

    // Anchor the gesture inside the container (so the right nested scroller
    // moves), or over the whole screen when none is named.
    const region = within ? selectorToFrame(tree, within) : FULL_SCREEN;
    if (!region) {
      return { reason: `scroll container ${describeSelector(within!)} is not visible` };
    }

    const fp = treeFingerprint(tree);
    if (prevFp !== undefined && fp === prevFp) {
      return { reason: `reached the end of the scroll without finding ${describeSelector(target)}` };
    }
    prevFp = fp;

    await scrollIncrement(registry, ctx, device, direction, region);
  }
  return {
    reason: `${describeSelector(target)} not found after ${MAX_SCROLL_ITERATIONS} scroll attempts`,
  };
}

/**
 * Resolve a selector to a frame, auto-scrolling it into view if it isn't in the
 * current viewport. The fast path is the plain wait (the element is already on
 * screen, possibly after a transition); only on a miss does it fall back to a
 * default vertical scroll. Explicit `scroll-to` steps cover other
 * directions/containers.
 */
async function resolveOrScroll(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  selector: Selector,
  signal?: AbortSignal
): Promise<DescribeFrame | undefined> {
  const frame = await waitForFrame(registry, device, selector, signal);
  if (frame) return frame;
  const scrolled = await scrollToVisible(registry, ctx, device, selector, "down", undefined, signal);
  return scrolled.frame;
}

/** Scroll a target into view (the `scroll-to` directive). */
export async function runScrollTo(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  step: { target: Selector; direction: ScrollDirection; within?: Selector },
  signal?: AbortSignal
): Promise<DirectiveOutcome> {
  const r = await scrollToVisible(registry, ctx, device, step.target, step.direction, step.within, signal);
  return { ok: Boolean(r.frame), reason: r.reason };
}

/**
 * Tap either an element (resolve a selector → frame, auto-waiting) or a raw
 * normalized point. Coordinate taps are the fallback for elements with no
 * stable selector (e.g. an unlabeled view).
 */
export async function runTap(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  target: { selector?: Selector; x?: number; y?: number },
  signal?: AbortSignal
): Promise<DirectiveOutcome> {
  let point: { x: number; y: number };
  if (target.selector) {
    const frame = await resolveOrScroll(registry, ctx, device, target.selector, signal);
    if (!frame) {
      return {
        ok: false,
        reason: `no visible element matched selector ${describeSelector(target.selector)}`,
      };
    }
    point = getDescribeTapPoint(frame);
  } else if (typeof target.x === "number" && typeof target.y === "number") {
    point = { x: target.x, y: target.y };
  } else {
    return { ok: false, reason: "tap needs a selector or x/y coordinates" };
  }
  await invokeSubTool(
    registry,
    ctx,
    "gesture-tap",
    bindDeviceArgs(registry, "gesture-tap", device.id, point)
  );
  return { ok: true };
}

/** Resolve `into` → tap to focus → type text via the keyboard tool. */
export async function runType(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  into: Selector,
  text: string,
  signal?: AbortSignal
): Promise<DirectiveOutcome> {
  const frame = await resolveOrScroll(registry, ctx, device, into, signal);
  if (!frame) {
    return { ok: false, reason: `no visible field matched selector ${describeSelector(into)}` };
  }
  const { x, y } = getDescribeTapPoint(frame);
  await invokeSubTool(
    registry,
    ctx,
    "gesture-tap",
    bindDeviceArgs(registry, "gesture-tap", device.id, { x, y })
  );
  await invokeSubTool(
    registry,
    ctx,
    "keyboard",
    bindDeviceArgs(registry, "keyboard", device.id, { text })
  );
  return { ok: true };
}

/**
 * Evaluate a condition against the current tree, retrying for a short grace
 * window ({@link DEFAULT_ASSERT_TIMEOUT_MS}) so an update that lands a frame
 * after an action isn't missed. Unlike `await`, this reports a *failure* (not
 * "still waiting") if the condition never holds.
 */
export async function runAssert(
  registry: Registry,
  device: DeviceInfo,
  condition: WaitCondition,
  selector: Selector,
  expectedText: string | undefined,
  signal?: AbortSignal
): Promise<DirectiveOutcome> {
  const deadline = Date.now() + DEFAULT_ASSERT_TIMEOUT_MS;

  let lastMatches: ReturnType<typeof findAll> = [];
  let fetchError: string | undefined;

  for (;;) {
    if (signal?.aborted) return { ok: false, reason: "assertion cancelled" };
    try {
      const { tree } = await fetchFlowTree(registry, device);
      lastMatches = findAll(tree, selector);
      fetchError = undefined;
      if (evaluateCondition(condition, expectedText, lastMatches)) return { ok: true };
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) break;
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, signal))) return { ok: false, reason: "assertion cancelled" };
  }

  if (fetchError) return { ok: false, reason: `could not read the UI tree: ${fetchError}` };
  return { ok: false, reason: assertReason(condition, selector, expectedText, lastMatches) };
}

function assertReason(
  condition: WaitCondition,
  selector: Selector,
  expectedText: string | undefined,
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
      return `an element matching ${sel} was still visible`;
    case "text": {
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      return first
        ? `element matched ${sel} but its text was "${nodeText(first)}" (wanted to contain "${expectedText}")`
        : `no element matched selector ${sel}`;
    }
    default:
      return `assertion failed for selector ${sel}`;
  }
}
