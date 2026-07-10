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
import { sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import { bindDeviceArgs } from "./flow-device";
import { fetchFlowTree } from "./flow-tree";
import {
  describeSelector,
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

/**
 * Re-read the describe tree until two consecutive reads are identical — the UI
 * has settled (a scroll's fling has stopped, an animation finished). Returns the
 * stable tree, the last tree read on timeout (best effort), or undefined if the
 * run was aborted. Resolving a frame from a settled tree is what keeps a tap
 * from landing mid-deceleration (where a scroll view swallows it) or acting on a
 * frame that has already moved.
 *
 * Throws when EVERY read in the window failed: that is a tree-source outage
 * (e.g. native devtools disconnected mid-run — `fetchFlowTree` refuses to
 * degrade to a trimmed tree), not a mid-animation blip, and swallowing it would
 * convert the outage into a misleading "element not found" downstream. The
 * throw lands in the step's structured report via `execLeafStep`'s catch.
 */
export async function settleTree(env: ActionEnv): Promise<DescribeNode | undefined> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let prevFp: string | undefined;
  let prevTree: DescribeNode | undefined;
  let lastError: Error | undefined;
  for (;;) {
    if (env.signal?.aborted) return undefined;
    let tree: DescribeNode | undefined;
    try {
      ({ tree } = await fetchFlowTree(env.registry, env.device));
    } catch (err) {
      // transient describe failure mid-navigation — retry until the deadline
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    // The abort can land while the read above is in flight (e.g. the HTTP
    // client disconnecting mid-flow trips the run's AbortController). Without
    // this re-check the two-identical-reads return below — or the deadline's
    // best-effort tree — would hand the caller a settled tree to act on, and a
    // gesture would still be dispatched after cancellation with the step
    // recorded as a pass instead of the uniform aborted skip.
    if (env.signal?.aborted) return undefined;
    if (tree !== undefined) {
      const fp = treeFingerprint(tree);
      if (prevFp !== undefined && fp === prevFp) return tree;
      prevFp = fp;
      prevTree = tree;
    }
    if (Date.now() >= deadline) {
      if (prevTree === undefined && lastError !== undefined) throw lastError;
      return prevTree;
    }
    if (!(await sleepOrAbort(SETTLE_POLL_MS, env.signal))) return undefined;
  }
}

/**
 * Poll until a visible element matches the selector, resolving against a
 * *settled* tree each round so the returned frame is stable. Returns the frame,
 * undefined once the deadline passes, or "aborted" when the run was cancelled —
 * the two misses must stay distinguishable, or a cancelled `tap`/`type` would
 * be reported as a genuine "element not found" failure.
 */
async function waitForFrame(
  env: ActionEnv,
  selector: FlowSelector
): Promise<DescribeFrame | "aborted" | undefined> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  for (;;) {
    if (env.signal?.aborted) return "aborted";
    const tree = await settleTree(env);
    if (tree) {
      const frame = flowSelectorToFrame(tree, selector);
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
 * viewport or larger) spanning it — returning its frame. Each round settles the
 * tree, checks the target, then — if it isn't fully in view — does one
 * momentum-free increment. Stopping only once the target has cleared the entry
 * edge (not on the first sliver) is what keeps a following `tap`/`snapshot`
 * off a half-clipped element. If a
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

    const tree = await settleTree(env);
    if (!tree) return { aborted: true }; // settleTree only returns undefined on abort

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

/** Execute one selector-acting directive (`tap` / `type` / `await` / `assert` / `scroll-to`). */
export async function runDirective(env: ActionEnv, step: DirectiveStep): Promise<DirectiveOutcome> {
  // Vega is remote-driven — there is no touch input, so the touch directives
  // can never act on it. Fail upfront with authoring guidance instead of a
  // low-level gesture dispatch error after the selector resolves.
  if (
    env.device.platform === "vega" &&
    (step.kind === "tap" || step.kind === "type" || step.kind === "scroll-to")
  ) {
    return {
      ok: false,
      reason: `${step.kind} is a touch directive and Vega is remote-driven — move focus with \`tool: tv-remote\` steps (and type via \`tool: keyboard\`) instead`,
    };
  }
  switch (step.kind) {
    case "tap":
      return runTap(env, step);
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
  }
}

/**
 * Tap either an element (resolve a selector → frame, auto-waiting) or a raw
 * normalized point. Coordinate taps are the fallback for elements with no
 * stable selector (e.g. an unlabeled view). `times` rides the gesture-tap
 * tool's `clickCount`: one resolution, one dispatched multi-tap gesture —
 * never N separate calls, whose RPC gaps could fall outside the OS
 * double-tap window.
 */
async function runTap(
  env: ActionEnv,
  target: { selector?: FlowSelector; x?: number; y?: number; times?: number }
): Promise<DirectiveOutcome> {
  let point: { x: number; y: number };
  if (target.selector) {
    const frame = await waitForFrame(env, target.selector);
    if (frame === "aborted") return ABORTED_OUTCOME;
    if (!frame) {
      return { ok: false, reason: offscreenHint(target.selector) };
    }
    point = getDescribeTapPoint(frame);
  } else if (typeof target.x === "number" && typeof target.y === "number") {
    point = { x: target.x, y: target.y };
  } else {
    return { ok: false, reason: "tap needs a selector or x/y coordinates" };
  }
  await invokeOnDevice(env, "gesture-tap", {
    ...point,
    ...(target.times !== undefined ? { clickCount: target.times } : {}),
  });
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
  let everTrustedRead = false;
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
      return ABORTED_OUTCOME;
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
      // No visible match on the final read means the deadline was spent on
      // blind reads (blank trees the poll refuses to trust once the element
      // has matched — see waitForCondition): the element may well be gone,
      // but that can't be confirmed, so don't claim it was still on screen.
      return matches.some(isVisible)
        ? `an element matching ${sel} was still visible`
        : `could not confirm the element is hidden — it was visible earlier, but the last UI reads returned an empty tree`;
    case "text": {
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      if (!first) return `no element matched selector ${sel}`;
      const wanted = textMatch === "equals" ? "equal" : "contain";
      // The check accepts the element's own label/value as well as its hoisted
      // subtree text (see evaluateCondition), so when they differ quote both —
      // the author may have been asserting against either.
      const shown = assertText(first);
      const own = nodeText(first);
      const ownNote = own && own !== shown ? ` (own text "${own}")` : "";
      return `element matched ${sel} but its text was "${shown}"${ownNote} (wanted to ${wanted} "${expectedText}")`;
    }
    default:
      return `assertion failed for selector ${sel}`;
  }
}
