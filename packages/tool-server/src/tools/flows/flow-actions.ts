import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { getDescribeTapPoint, type DescribeFrame, type DescribeNode } from "../describe/contract";
import {
  selectorToFrame,
  findAll,
  evaluateCondition,
  firstInReadingOrder,
  isVisible,
  assertText,
  treeFingerprint,
  type Selector,
  type WaitCondition,
  type TextMatchMode,
} from "../../utils/ui-tree-match";
import { sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import { bindDeviceArgs } from "./flow-device";
import { fetchFlowTree } from "./flow-ios-tree";
import type { FlowSelector, FlowStep, ScrollDirection } from "./flow-utils";

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
}

/** The selector-acting steps {@link runDirective} handles. */
export type DirectiveStep = Extract<
  FlowStep,
  { kind: "tap" | "type" | "await" | "assert" | "scroll-to" }
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

// Settle detection: re-read the tree until two consecutive reads match, so a tap
// never lands mid-fling and a resolved frame can't go stale before we act.
const SETTLE_POLL_MS = 250;
const SETTLE_TIMEOUT_MS = 3000;

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
const DEFAULT_ASSERT_TIMEOUT_MS = 1000;

function describeSelector(s: FlowSelector): string {
  return Object.entries(s)
    .filter(([k]) => k !== "loose")
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
}

/**
 * The strict selectors a flow selector resolves through, in order. A loose
 * selector (bare-string sugar, `tap: foo`) tries the identifier locator first
 * and falls back to text (label/value) only when that finds nothing — so a
 * hand-written `foo` matches a `testID="foo"` as well as visible text. Explicit
 * `{ text }` / `{ identifier }` selectors carry no flag and match strictly.
 * Lives in the flow runner only; the shared match engine and the tools that
 * consume it are untouched.
 */
function selectorAlternatives(sel: FlowSelector): Selector[] {
  return sel.loose && sel.text !== undefined
    ? [{ identifier: sel.text }, { text: sel.text }]
    : [sel];
}

/** Resolve a selector's matches honoring the bare-string `loose` fallback. */
function flowFindAll(tree: DescribeNode, sel: FlowSelector): DescribeNode[] {
  for (const s of selectorAlternatives(sel)) {
    const matches = findAll(tree, s);
    if (matches.length > 0) return matches;
  }
  return [];
}

/** Identifier-first-then-text frame resolution for a (possibly loose) selector. */
function flowSelectorToFrame(tree: DescribeNode, sel: FlowSelector): DescribeFrame | undefined {
  for (const s of selectorAlternatives(sel)) {
    const frame = selectorToFrame(tree, s);
    if (frame) return frame;
  }
  return undefined;
}

/**
 * Re-read the describe tree until two consecutive reads are identical — the UI
 * has settled (a scroll's fling has stopped, an animation finished). Returns the
 * stable tree, the last tree read on timeout (best effort), or undefined if the
 * run was aborted. Resolving a frame from a settled tree is what keeps a tap
 * from landing mid-deceleration (where a scroll view swallows it) or acting on a
 * frame that has already moved.
 */
export async function settleTree(env: ActionEnv): Promise<DescribeNode | undefined> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let prevFp: string | undefined;
  let prevTree: DescribeNode | undefined;
  for (;;) {
    if (env.signal?.aborted) return undefined;
    try {
      const { tree } = await fetchFlowTree(env.registry, env.device);
      const fp = treeFingerprint(tree);
      if (prevFp !== undefined && fp === prevFp) return tree;
      prevFp = fp;
      prevTree = tree;
    } catch {
      // transient describe failure mid-navigation — retry until the deadline
    }
    if (Date.now() >= deadline) return prevTree;
    if (!(await sleepOrAbort(SETTLE_POLL_MS, env.signal))) return undefined;
  }
}

/**
 * Poll until a visible element matches the selector, resolving against a
 * *settled* tree each round so the returned frame is stable. Returns the frame,
 * or undefined if the deadline passes / the run is aborted.
 */
async function waitForFrame(
  env: ActionEnv,
  selector: FlowSelector
): Promise<DescribeFrame | undefined> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  for (;;) {
    if (env.signal?.aborted) return undefined;
    const tree = await settleTree(env);
    if (tree) {
      const frame = flowSelectorToFrame(tree, selector);
      if (frame) return frame;
    }
    if (Date.now() >= deadline) return undefined;
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) return undefined;
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
  env: ActionEnv,
  target: FlowSelector,
  direction: ScrollDirection,
  within: FlowSelector | undefined
): Promise<ScrollResolve> {
  let prevFp: string | undefined;
  for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
    if (env.signal?.aborted) return { reason: "scroll cancelled" };

    const tree = await settleTree(env);
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

/**
 * Resolve a selector to a frame, auto-scrolling it into view if it isn't in the
 * current viewport. The fast path is the plain wait (the element is already on
 * screen, possibly after a transition); only on a miss does it fall back to a
 * default vertical scroll. Explicit `scroll-to` steps cover other
 * directions/containers.
 */
async function resolveOrScroll(
  env: ActionEnv,
  selector: FlowSelector
): Promise<DescribeFrame | undefined> {
  const frame = await waitForFrame(env, selector);
  if (frame) return frame;
  const scrolled = await scrollToVisible(env, selector, "down", undefined);
  return scrolled.frame;
}

/** Execute one selector-acting directive (`tap` / `type` / `await` / `assert` / `scroll-to`). */
export async function runDirective(env: ActionEnv, step: DirectiveStep): Promise<DirectiveOutcome> {
  switch (step.kind) {
    case "tap":
      return runTap(env, step);
    case "type":
      return runType(env, step);
    case "await":
      return waitForCondition(env, step, step.timeout ?? DEFAULT_ACTION_TIMEOUT_MS, "await");
    case "assert":
      return waitForCondition(env, step, DEFAULT_ASSERT_TIMEOUT_MS, "assertion");
    case "scroll-to": {
      const r = await scrollToVisible(env, step.target, step.direction, step.within);
      return { ok: Boolean(r.frame), reason: r.reason };
    }
  }
}

/**
 * Tap either an element (resolve a selector → frame, auto-waiting) or a raw
 * normalized point. Coordinate taps are the fallback for elements with no
 * stable selector (e.g. an unlabeled view).
 */
async function runTap(
  env: ActionEnv,
  target: { selector?: FlowSelector; x?: number; y?: number }
): Promise<DirectiveOutcome> {
  let point: { x: number; y: number };
  if (target.selector) {
    const frame = await resolveOrScroll(env, target.selector);
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
  await invokeOnDevice(env, "gesture-tap", point);
  return { ok: true };
}

/**
 * Resolve `into` → tap to focus → type text via the keyboard tool. Unless
 * `submit` is explicitly `false`, a trailing Enter is pressed to commit the
 * value and dismiss the keyboard, so it can't obscure later steps (chained
 * form fields that end in an explicit submit `tap` should pass `submit: false`).
 */
async function runType(
  env: ActionEnv,
  step: { into: FlowSelector; text: string; submit?: boolean }
): Promise<DirectiveOutcome> {
  const frame = await resolveOrScroll(env, step.into);
  if (!frame) {
    return {
      ok: false,
      reason: `no visible field matched selector ${describeSelector(step.into)}`,
    };
  }
  await invokeOnDevice(env, "gesture-tap", getDescribeTapPoint(frame));
  await invokeOnDevice(env, "keyboard", { text: step.text });
  if (step.submit !== false) {
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
 * - `await` (action-length timeout) — a real wait for a transition. Evaluating
 *   it here, rather than delegating to the `await-ui-element` tool, gives it
 *   the same loose bare-string semantics (identifier-first, then text) and the
 *   same full-hierarchy tree source as every other selector directive; the raw
 *   `tool: await-ui-element` step remains the escape hatch for custom
 *   timeout/poll/bundleId.
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
  timeoutMs: number,
  what: "await" | "assertion"
): Promise<DirectiveOutcome> {
  const deadline = Date.now() + timeoutMs;

  let lastMatches: ReturnType<typeof findAll> = [];
  let fetchError: string | undefined;
  let everMatched = false;
  let everTrustedRead = false;
  let finalPoll = false;

  for (;;) {
    if (env.signal?.aborted) return { ok: false, reason: `${what} cancelled` };
    try {
      const data = await fetchFlowTree(env.registry, env.device);
      lastMatches = flowFindAll(data.tree, step.selector);
      fetchError = undefined;
      everMatched ||= lastMatches.length > 0;
      const blind =
        data.tree.children.length === 0 && Boolean(data.hint || data.should_restart || everMatched);
      everTrustedRead ||= !blind;
      if (
        !blind &&
        evaluateCondition(step.condition, step.expectedText, lastMatches, step.textMatch)
      ) {
        return { ok: true };
      }
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      if (finalPoll) break;
      finalPoll = true;
      continue;
    }
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) {
      return { ok: false, reason: `${what} cancelled` };
    }
  }

  if (fetchError) return { ok: false, reason: `could not read the UI tree: ${fetchError}` };
  if (step.condition === "hidden" && !everTrustedRead) {
    return {
      ok: false,
      reason: "could not confirm the element is hidden — the UI tree was empty or unreadable",
    };
  }
  return {
    ok: false,
    reason: assertReason(
      step.condition,
      step.selector,
      step.expectedText,
      step.textMatch,
      lastMatches
    ),
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
      return `an element matching ${sel} was still visible`;
    case "text": {
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      const wanted = textMatch === "equals" ? "equal" : "contain";
      return first
        ? `element matched ${sel} but its text was "${assertText(first)}" (wanted to ${wanted} "${expectedText}")`
        : `no element matched selector ${sel}`;
    }
    default:
      return `assertion failed for selector ${sel}`;
  }
}
