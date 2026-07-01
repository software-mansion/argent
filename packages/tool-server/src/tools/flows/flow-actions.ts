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
  type WaitCondition,
} from "../../utils/ui-tree-match";
import { sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import { bindDeviceArgs } from "./flow-device";
import { fetchFlowTree } from "./flow-native-tree";
import type { FlowSelector, ScrollDirection } from "./flow-utils";

/** Outcome of a selector directive: ok, or a machine-readable reason it failed. */
export interface DirectiveOutcome {
  ok: boolean;
  reason?: string;
}

const DEFAULT_ACTION_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 300;

// Settle detection: re-read the tree until two consecutive reads match, so a tap
// never lands mid-fling and a resolved frame can't go stale before we act.
const SETTLE_POLL_MS = 250;
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

// Edge tolerance (normalized) for "is this frame flush against a clip edge".
// A hair above the frame-fingerprint rounding (1e-3) so sub-pixel jitter never
// reads as a clip, but small enough that a genuinely clipped edge lands on it.
const EDGE_EPS = 0.005;

/**
 * Is `frame` fully within `clip` along the scroll axis, with its *entry* edge
 * cleared of the clip boundary by a margin? Every describe adapter clips a
 * partly-scrolled element's frame to the viewport (iOS/Chromium clamp their
 * rects to [0,1]; Android uiautomator reports bounds already clipped to the
 * scroll container), so such an element sits exactly flush against the edge it
 * is being revealed from — a row entering from the bottom has `y+h == clip.bottom`.
 * "Flush against the entry edge" is therefore the universal clipped signal.
 * Requiring the entry edge strictly inside (by `EDGE_EPS`), with the opposite
 * edge still within the clip, means the whole element has cleared the fold. The
 * entry edge is set by the scroll direction: `down` reveals from the bottom,
 * `up` from the top, etc.
 */
function axisFullyInside(
  frame: DescribeFrame,
  direction: ScrollDirection,
  clip: DescribeFrame
): boolean {
  const top = clip.y;
  const bottom = clip.y + clip.height;
  const left = clip.x;
  const right = clip.x + clip.width;
  const fTop = frame.y;
  const fBottom = frame.y + frame.height;
  const fLeft = frame.x;
  const fRight = frame.x + frame.width;
  switch (direction) {
    case "down": // entered from the bottom edge
      return fBottom <= bottom - EDGE_EPS && fTop >= top - EDGE_EPS;
    case "up": // entered from the top edge
      return fTop >= top + EDGE_EPS && fBottom <= bottom + EDGE_EPS;
    case "right": // entered from the right edge
      return fRight <= right - EDGE_EPS && fLeft >= left - EDGE_EPS;
    case "left": // entered from the left edge
      return fLeft >= left + EDGE_EPS && fRight <= right + EDGE_EPS;
  }
}

// `assert` is a correctness check, not an open-ended wait — but UI updates after
// an action land asynchronously, so a strictly one-shot read races the
// re-render (e.g. a counter that increments a frame after a tap). Like
// Playwright's web-first assertions, assert retries for a short grace window so
// it absorbs that latency; a genuinely-false assertion still fails quickly.
const DEFAULT_ASSERT_TIMEOUT_MS = 500;

function describeSelector(s: FlowSelector): string {
  return Object.entries(s)
    .filter(([k]) => k !== "loose")
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
}

/**
 * Resolve a selector's matches honoring the bare-string `loose` flag. A loose
 * selector (`tap: foo`) tries the identifier locator first and, only if it finds
 * nothing, falls back to text (label/value) — so a hand-written `foo` matches a
 * `testID="foo"` as well as visible text. Explicit `{ text }` / `{ identifier }`
 * selectors carry no flag and match strictly. Lives in the flow runner only; the
 * shared match engine and the tools that consume it are untouched.
 */
function flowFindAll(tree: DescribeNode, sel: FlowSelector): DescribeNode[] {
  if (sel.loose && sel.text !== undefined) {
    const byIdentifier = findAll(tree, { identifier: sel.text });
    if (byIdentifier.length > 0) return byIdentifier;
    return findAll(tree, { text: sel.text });
  }
  return findAll(tree, sel);
}

/** Identifier-first-then-text frame resolution for a (possibly loose) selector. */
function flowSelectorToFrame(tree: DescribeNode, sel: FlowSelector): DescribeFrame | undefined {
  if (sel.loose && sel.text !== undefined) {
    return (
      selectorToFrame(tree, { identifier: sel.text }) ?? selectorToFrame(tree, { text: sel.text })
    );
  }
  return selectorToFrame(tree, sel);
}

/**
 * Re-read the describe tree until two consecutive reads are identical — the UI
 * has settled (a scroll's fling has stopped, an animation finished). Returns the
 * stable tree, the last tree read on timeout (best effort), or undefined if the
 * run was aborted. Resolving a frame from a settled tree is what keeps a tap
 * from landing mid-deceleration (where a scroll view swallows it) or acting on a
 * frame that has already moved.
 */
export async function settleTree(
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
  selector: FlowSelector,
  signal?: AbortSignal
): Promise<DescribeFrame | undefined> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return undefined;
    const tree = await settleTree(registry, device, signal);
    if (tree) {
      const frame = flowSelectorToFrame(tree, selector);
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
      durationMs: 600,
    })
  );
}

/**
 * Scroll until `target` is fully within the scroll viewport along the scroll
 * axis, returning its frame. Each round settles the tree, checks the target,
 * then — if it isn't fully in view — does one momentum-free increment. Stopping
 * only once the target has cleared the entry edge (not on the first sliver) is
 * what keeps a following `tap`/`snapshot` off a half-clipped element. If a
 * round's settled tree is identical to the previous round's, the container has
 * hit its end (or the anchor scrolls nothing): the target is then as visible as
 * it will ever be, so it's accepted wherever it landed — the LAST item sits
 * flush against the far edge and can never clear it, and a genuinely stuck
 * partial can't be improved either. A target already fully on screen returns
 * immediately (no scroll).
 */
async function scrollToVisible(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  target: FlowSelector,
  direction: ScrollDirection,
  within: FlowSelector | undefined,
  signal?: AbortSignal
): Promise<ScrollResolve> {
  let prevFp: string | undefined;
  for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
    if (signal?.aborted) return { reason: "scroll cancelled" };

    const tree = await settleTree(registry, device, signal);
    if (!tree) return { reason: "scroll cancelled" };

    // Anchor the gesture inside the container (so the right nested scroller
    // moves), or over the whole screen when none is named. Its frame is also the
    // clip window the axis check measures the target against.
    const region = within ? flowSelectorToFrame(tree, within) : FULL_SCREEN;
    if (!region) {
      return { reason: `scroll container ${describeSelector(within!)} is not visible` };
    }

    const frame = flowSelectorToFrame(tree, target);
    if (frame && axisFullyInside(frame, direction, region)) return { frame };

    const fp = treeFingerprint(tree);
    if (prevFp !== undefined && fp === prevFp) {
      // End of the scroll — accept the target wherever it landed (best effort).
      if (frame) return { frame };
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
  selector: FlowSelector,
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
  step: { target: FlowSelector; direction: ScrollDirection; within?: FlowSelector },
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
  target: { selector?: FlowSelector; x?: number; y?: number },
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

/**
 * Resolve `into` → tap to focus → type text via the keyboard tool. Unless
 * `submit` is explicitly `false`, a trailing Enter is pressed to commit the
 * value and dismiss the keyboard, so it can't obscure later steps (chained
 * form fields that end in an explicit submit `tap` should pass `submit: false`).
 */
export async function runType(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  into: FlowSelector,
  text: string,
  submit: boolean | undefined,
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
  if (submit !== false) {
    // Press Enter as a separate keyboard call — the tool dispatches `key`
    // before `text`, so a combined `{ text, key }` would submit before typing.
    await invokeSubTool(
      registry,
      ctx,
      "keyboard",
      bindDeviceArgs(registry, "keyboard", device.id, { key: "enter" })
    );
  }
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
  selector: FlowSelector,
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
      lastMatches = flowFindAll(tree, selector);
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
  selector: FlowSelector,
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
