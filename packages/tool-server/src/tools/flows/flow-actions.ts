import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import {
  getDescribeTapPoint,
  type DescribeFrame,
  type DescribeNode,
  type DescribeSource,
  type DescribeTreeData,
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
import { fetchFlowTree, supportsFlowTree } from "./flow-tree";
import {
  capturePixelsWithin,
  comparePixels,
  statusBarMaskFraction,
  type PixelFrame,
} from "./flow-pixels";
import {
  buildAxisCandidate,
  decomposePinch,
  selectPinchCandidate,
  systemEdgeGuards,
  PINCH_SETTLE_MS,
  type PinchCandidate,
} from "./flow-pinch-geometry";
import {
  buildRotateCandidate,
  deriveRotateDurationMs,
  selectRotateCandidate,
  type RotateCandidate,
} from "./flow-rotate-geometry";
import {
  describeSelector,
  describeTextExpectation,
  IDLE_DEFAULT_STABLE_FOR_MS,
  IDLE_DEFAULT_TIMEOUT_MS,
  IDLE_MIN_STILL_INTERVALS,
  IDLE_POLL_MS,
  SELECTOR_RELATIONS,
  type FlowSelector,
  type FlowStep,
  type ScrollDirection,
} from "./flow-utils";

/**
 * The app an iOS tree read should describe, and how far the runner will vouch
 * for it (see `queryFullHierarchyTree` for what each level buys).
 */
export interface FlowTreeTarget {
  /**
   * App id of the run's most recent successful `launch` step - or, after a
   * `tool:` `launch-app`/`restart-app` step, of the app that step started.
   */
  bundleId: string;
  /**
   * Whether the runner still vouches that `bundleId` is what is on screen. A
   * pinned read targets it directly, skipping the auto-resolve fan-out that
   * probes every connected app. Unpinned, it is only a hint: auto-resolve
   * decides the target, and `bundleId` breaks the tie solely when that
   * resolution times out.
   */
  pinned: boolean;
  /**
   * Whether a pinned read's `Application.getState` probe has ever answered for
   * THIS target. MUTATED IN PLACE by `queryFullHierarchyTree` (its only writer
   * after construction) so every read of the same pin sees it — `deviceEnv`
   * shallow-spreads the run state, so they all reach the same object.
   *
   * It is the only evidence the runner has that the app's main queue was ever
   * serviced, which tells the two causes of a timed-out probe apart. A later
   * `launch` builds a fresh target, since a re-pinned app cold-starts again;
   * an unpinned target neither consults nor arms it.
   */
  probeAnswered: boolean;
}

/** Everything a directive needs to act on the run's device. */
export interface ActionEnv {
  registry: Registry;
  ctx?: ToolContext;
  device: DeviceInfo;
  signal?: AbortSignal;
  /**
   * The app the run's most recent successful `launch` step started - or, after
   * a `tool:` `launch-app`/`restart-app` step, the app that step's own args
   * named - and whether the runner still vouches for it being on screen.
   * Demoted to an unpinned hint by a raw `tool:` step (its effect on the
   * foreground is opaque to the runner), dropped outright by a `tool:` step
   * that can change the foreground app and by a launch attempt until it
   * succeeds (see `FOREGROUND_CHANGING_TOOLS` in flow-run). Shared with nested
   * `run:` flows, since ExecState is per-run. Only iOS tree reads consume it
   * (see `fetchFlowTree`).
   */
  treeTarget?: FlowTreeTarget;
  /**
   * Run-scoped memo of a tree source that answered nothing: written by a
   * {@link settleTree} that failed every read attempt, cleared by any directive
   * read that comes back — they all go through {@link readFlowTree} — by a
   * relaunch (`launch:` or one of flow-run's `FOREGROUND_CHANGING_TOOLS`), by a
   * raw `tool:` step that demotes a pinned {@link ActionEnv.treeTarget}, and by
   * a nested orchestrator step, which can do either out of this holder's sight.
   * One holder per run, built in flow-run's ExecState and shared by every
   * `deviceEnv`. A `tool:` step's own read clears nothing: it goes through
   * `invokeSubTool` and never reaches {@link readFlowTree}. Nor is the clear
   * ordered against the step running —
   * `idle` stops waiting on its read at the round budget, so that read can land
   * later and retire a verdict minted after it was issued.
   *
   * Only {@link settleForGesture} READS it, and only to skip a settle already
   * shown to be unaffordable; the gesture then warns its step report that it
   * dispatched unsettled. {@link fetchScreenAspect} does not consult it — its
   * answer is dispatched rather than waited on — and neither does `runSnapshot`,
   * whose settle IS waited on but whose capture has no `warning` channel
   * (`VisualOutcome` has no such field), so being wrong there would cost a step
   * rather than a settle.
   *
   * The write carries the device it was proven against: a verdict about a
   * device the run has left says nothing about the one it moved onto. The clear
   * is deliberately NOT keyed — over-clearing only ever costs a later gesture a
   * settle it would have skipped. Absent for a caller that builds an
   * `ActionEnv` by hand, which leaves every settle on its own budget.
   */
  treeOutage?: { proven?: { deviceId: string; error: Error } };
}

/** Outcome of a selector directive: ok, or a machine-readable reason it failed. */
export interface DirectiveOutcome {
  ok: boolean;
  reason?: string;
  /** The run was cancelled mid-step — reported as a skip, not a step failure. */
  aborted?: boolean;
  /**
   * The condition could not be evaluated — unknown, not false: the window never
   * produced a trustworthy read, or a `hidden` check ended on a blind or failed
   * read after the element had matched. The `when:` guard probe errors on it
   * rather than silently skipping a block a broken tree source can't vouch for;
   * a plain `assert` reports it as an ordinary failure; `idle`, which has no
   * condition to fall back on, is scored `error`; the recorder's cross-tree
   * re-probe keeps the step and warns that the conversion is UNKNOWN, not
   * known-bad.
   */
  indeterminate?: boolean;
  /**
   * The step passed, but the WAY it passed weakens it as proof — carried into
   * the step report.
   */
  warning?: string;
  /**
   * The tolerated failed read behind a DETERMINATE verdict — the trailing
   * poll's error, worded as {@link waitForCondition} already appends it to
   * `reason`. On its own field so a caller that phrases its own verdict line
   * (the drain's cap in flow-run) can carry the detail without slicing it out
   * of a message. An evidence gap wide enough to doubt the verdict is
   * `indeterminate` instead, never this.
   */
  blipNote?: string;
}

/**
 * The uniform outcome for a step cut short by run cancellation (directives
 * here, `launch` in flow-run.ts). The runner reports it as a skip — an aborted
 * run says nothing about the app, so it must never read as a genuine step
 * failure with a misleading reason.
 */
export const ABORTED_OUTCOME: DirectiveOutcome = {
  ok: false,
  aborted: true,
  reason: "run aborted",
};

/** The condition/action steps {@link runDirective} handles. */
type DirectiveStep = Extract<
  FlowStep,
  {
    kind:
      | "tap"
      | "long-press"
      | "type"
      | "await"
      | "assert"
      | "idle"
      | "scroll-to"
      | "pinch"
      | "rotate";
  }
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
// unconditional head start; `waitForFocus` then polls, on sources that report
// focus, until the tapped frame holds it.
const TYPE_FOCUS_SETTLE_MS = 500;
const TYPE_FOCUS_TIMEOUT_MS = 3000;

// Tree sources that surface `focused`. A source outside this set (Vega's
// toolkit page source) never reports it, so polling would burn the whole
// timeout on every type step — skip the focus wait there instead.
const FOCUS_REPORTING_SOURCES: ReadonlySet<DescribeSource> = new Set([
  "native-devtools",
  "android-devtools",
  "cdp-dom",
]);

// Re-read the tree until two consecutive reads match, so a tap never lands
// mid-fling and a resolved frame can't go stale before we act.
const SETTLE_POLL_MS = 250;
/**
 * How long that re-reading gets. Exported for flow-settle-min-reads.test.ts,
 * which derives its slow reads from it: a hand-copied number would survive this
 * one being raised above it and quietly stop pricing the floor below.
 */
export const SETTLE_TIMEOUT_MS = 3000;

// Read attempts every settle makes before it may conclude anything, enforced
// even once the window has closed. A read can fail by TIMING OUT, and every
// tree source's RPC timeout outlasts the 3s window: 5s is the shortest tier any
// of them allows, and a whole read chains several (an iOS read spends up to 5s
// resolving the target app before a 15s `getFullHierarchy`). Without a floor,
// "every read in the window failed" — which the throw below reports as a
// tree-source outage — would collapse into "the first read was slow", erroring
// a step on one transient blip with no retry at all. The second read is not
// bounded by the window either, so a wedged source costs two full reads, and
// `scroll-to` pays that on every one of its rounds.
const SETTLE_MIN_READS = 2;

// `scroll-to`: a bounded number of momentum-free increments, each travelling
// half the clip window along the scroll axis — < 1 viewport, so consecutive
// viewports overlap and a target can never be skipped over between two settle
// checkpoints. The floor keeps the gesture in a tiny container large enough to
// register as a scroll rather than a tap.
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
 * 1. Fully within the clip, with its *entry* edge (set by the direction: `down`
 *    reveals from the bottom) strictly inside by `EDGE_EPS`. Every describe
 *    adapter clips a partly-scrolled element's frame to the viewport
 *    (iOS/Chromium clamp their rects to [0,1]; Android uiautomator reports
 *    bounds already clipped to the scroll container), so a half-revealed
 *    element sits exactly flush against the edge it is being revealed from —
 *    clearing that edge means the whole element has cleared the fold.
 * 2. Spanning the whole clip along the axis (both edges covered, with
 *    `EDGE_EPS` slack). A target at least as large as the clip can never fit
 *    both edges inside it, so shape 1 is arithmetically unsatisfiable for it,
 *    and no scroll can reveal more of it — so it is accepted where it stands
 *    rather than scrolling (and possibly burning every iteration) while on
 *    screen the whole time.
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

// `assert` is a correctness check, not an open-ended wait — but UI updates land
// asynchronously, so a one-shot read races the re-render (a counter that
// increments a frame after a tap). Like Playwright's web-first assertions it
// retries for a short grace window; a genuinely-false assertion still fails
// quickly.
const DEFAULT_ASSERT_TIMEOUT_MS = 1000;

// Evidence-gap bound for `waitForCondition`'s post-timeout verdict: how far
// behind the loop's exit the last TRUSTED read may lie before a determinate
// "condition false" verdict stops being honest. Two poll intervals budgets the
// worst genuine last-poll blip — an interval of sleep since the last clean
// read, plus an interval for the deadline poll and its back-to-back retry both
// failing. Anything longer means consecutive polls went dark, and a verdict
// narrated from before the darkness would describe a screen nobody saw at the
// deadline.
const CONDITION_DARK_TAIL_TOLERANCE_MS = POLL_INTERVAL_MS * 2;

/**
 * Evaluate a UI condition on the assert grace window — the same engine as
 * `assert`, deliberately not an await-sized wait. `indeterminate` distinguishes
 * an unreadable tree (unknown, not false) from a plainly unmet condition.
 *
 * Both callers want exactly that window: the `when:` block guard, where a
 * skipped block must not add a dead wait to every clean run (unknown → error,
 * unmet → skip), and the recorder's cross-tree re-probe, because that is the
 * window an `assert:` conversion would get.
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
 * and falls back to text (label/value) only when that finds nothing — so `foo`
 * matches a `testID="foo"` as well as visible text. Explicit `{ text }` /
 * `{ id }` selectors carry no flag and match strictly.
 *
 * Every relational scope (`within`/`after`/`next`) expands recursively and
 * cross-combines, identifier-first at every level. No `loose` flag survives at
 * any depth.
 *
 * The product is exponential in the number of BARE-STRING scopes, which is what
 * bounds it: only a bare string is loose, a bare string carries no scope of its
 * own, and the parser caps a selector's whole relation tree at
 * MAX_SELECTOR_SCOPES. (That cap is a tree-SIZE bound for exactly this reason:
 * a depth bound alone would admit 3^depth loose leaves.)
 *
 * `any` is dropped here: a field-less selector is already what the match engine
 * reads as "every element".
 */
function selectorAlternatives(sel: FlowSelector): Selector[] {
  const { loose, any: _any, within, after, next, ...own } = sel;
  const scopes = { within, after, next };
  let alts: Selector[] =
    loose && own.text !== undefined ? [{ identifier: own.text }, { text: own.text }] : [own];
  for (const relation of SELECTOR_RELATIONS) {
    const scope = scopes[relation];
    if (scope === undefined) continue;
    const scopeAlts = selectorAlternatives(scope);
    alts = alts.flatMap((o) => scopeAlts.map((s) => ({ ...o, [relation]: s })));
  }
  return alts;
}

/**
 * Resolve a selector's matches honoring the bare-string `loose` fallback. A pass
 * wins outright only when it has a *visible* match — the same criterion
 * {@link flowSelectorToFrame} falls through on, so `await`/`assert` and
 * `tap`/`type` resolve a bare string to the same element. An all-zero-area pass
 * is kept only as a last resort, so `exists` still sees those nodes without
 * blocking the text pass from finding the visible element.
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
 * The run's outage verdict, if one was proven against the device in hand: a
 * verdict about a device the run has left says nothing about this one.
 */
function provenTreeOutage(env: ActionEnv): Error | undefined {
  const proven = env.treeOutage?.proven;
  return proven && proven.deviceId === env.device.id ? proven.error : undefined;
}

/**
 * Every tree read a directive makes, so a read that comes back clears
 * {@link ActionEnv.treeOutage} whichever directive asked for it. `await`/
 * `assert`, `idle`'s read and the rotate aspect read never settle, so a clear
 * living in {@link settleTree} alone would let a run read the tree successfully
 * over and over and still have every later coordinate gesture skip its settle
 * on the strength of one old failure.
 *
 * The `type` focus wait routes here for uniformity but can never be the read
 * that clears a verdict: it runs only after {@link waitForFrame} resolved a
 * frame, and the settle that took already cleared it.
 */
function readFlowTree(env: ActionEnv): Promise<DescribeTreeData> {
  return fetchFlowTree(env.registry, env.device, env.treeTarget).then((data) => {
    if (env.treeOutage) env.treeOutage.proven = undefined;
    return data;
  });
}

/**
 * Re-read the describe tree until two consecutive reads are identical — the UI
 * has settled (a scroll's fling has stopped, an animation finished). Returns the
 * stable tree, the last tree read on timeout (best effort), or undefined if the
 * run was aborted. Resolving a frame from a settled tree is what keeps a tap
 * from landing mid-deceleration (where a scroll view swallows it) or acting on a
 * frame that has already moved.
 *
 * Throws when EVERY read attempt failed: that is a tree-source outage
 * (`fetchFlowTree` refuses to degrade to a trimmed tree), not a mid-animation
 * blip, and swallowing it would convert the outage into a misleading "element
 * not found" downstream. The throw lands in the step's structured report via
 * `execLeafStep`'s catch.
 *
 * "Every attempt" is at least {@link SETTLE_MIN_READS} of them: the deadline
 * bounds the polling, never the number of reads taken, so a read slow enough to
 * outlast the window on its own is retried rather than treated as the whole
 * evidence. The price lands on the best-effort return, which can then be a tree
 * a whole read older than the bare deadline would have handed back — including
 * to `snapshot: { cropOn }` through {@link waitForFrame}, where it widens the
 * gap between the read the crop rectangle comes from and the capture.
 *
 * `skipProvenOutage` rethrows {@link ActionEnv.treeOutage} instead of buying
 * that whole settle again. Not a shorter budget: a threshold low enough to
 * spare a source serving no tree at all would also abandon the mid-navigation
 * blip the retry above exists for. The memo is a prediction — one settle mints
 * it and nothing re-tests it — so being wrong costs a settle, not a step:
 * {@link settleForGesture} swallows the throw and warns every gesture it spares.
 */
export async function settleTree(
  env: ActionEnv,
  opts: { skipProvenOutage?: boolean } = {}
): Promise<DescribeNode | undefined> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let prevFp: string | undefined;
  let prevTree: DescribeNode | undefined;
  let lastError: Error | undefined;
  let reads = 0;
  for (;;) {
    if (env.signal?.aborted) return undefined;
    // Inside the loop so the abort above still wins, but only ever true on the
    // first pass: the memo is written by the throw below, which leaves the loop.
    const proven = provenTreeOutage(env);
    if (opts.skipProvenOutage && proven) throw proven;
    // The signal bounds the wait; nothing else does. A budget of what is left
    // of the window would fail the slow cold start #778 raised
    // `ViewHierarchy.getFullHierarchy` to a 15s RPC tier to ride out.
    const read = await settleWithin(readFlowTree(env), undefined, env.signal);
    let tree: DescribeNode | undefined;
    if (read.type === "value") {
      tree = read.value.tree;
    } else if (read.type === "error") {
      // transient describe failure mid-navigation — retry until the deadline
      lastError = read.cause;
    }
    reads += 1;
    // The abort can land while the read above is in flight. Without this
    // re-check the returns below would hand the caller a tree to act on, and a
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
      // Owed another attempt: retry back-to-back rather than sleeping out a
      // poll interval the window no longer has (`waitForCondition`'s final
      // poll does the same). Bounded — `reads` rises on every pass.
      if (reads < SETTLE_MIN_READS) continue;
      if (prevTree === undefined && lastError !== undefined) {
        if (env.treeOutage) env.treeOutage.proven = { deviceId: env.device.id, error: lastError };
        throw lastError;
      }
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
 *
 * Exported for `snapshot: { cropOn }` (flow-visual.ts), which resolves the crop
 * element's frame with the same settle + auto-wait.
 */
export async function waitForFrame(
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
 * Is this node a scroll container? Android's uiautomator dump flags one directly
 * (`scrollable`); the iOS full-hierarchy adapter carries no such flag but maps
 * UIScrollView/UITableView/UICollectionView class names to the AXScrollArea
 * role, which the role test catches. The Chromium DOM walker sets `scrollable`
 * on overflow scrollers too, but the flow adapter (`projectChromiumNode`) only
 * emits leaves that are otherwise addressable — an ANONYMOUS overflow scroller
 * never reaches the flow tree, and the caller falls back to the whole screen.
 */
function isScrollContainer(node: DescribeNode): boolean {
  return node.scrollable === true || /scroll/i.test(node.role);
}

/**
 * Frames of every visible scroll container whose frame contains the swipe
 * anchor. The OS routes a scroll gesture to a scroller hit-tested at the anchor,
 * so the container that will actually move is among these. ALL of them are
 * returned rather than just the innermost: the innermost may not scroll along
 * the requested axis at all (a horizontal carousel under a vertical swipe hands
 * the gesture to an ancestor), and an end-of-scroll fingerprint scoped to it
 * alone would misread the outer scroller's real progress as "stuck". Empty when
 * the tree surfaces no scroll container at the anchor.
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
 * each round — keyboard avoidance routinely scrolls the field away from where it
 * was tapped — with `tappedFrame` covering rounds where the selector momentarily
 * doesn't resolve. Best-effort by design: a source that can't report focus
 * returns immediately, and an unconfirmed poll falls through to typing rather
 * than failing the step, since "no focus seen" can also mean the focused view
 * didn't make it into the tree.
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
      const { tree, source } = await readFlowTree(env);
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
 * right container), sized to the clip window rather than the screen so
 * consecutive views of a small container's content still overlap. Touch
 * platforms use a `settle` swipe (no fling); Chromium uses wheel events.
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
 * along the scroll axis — fully inside it, or (for a target at least as large as
 * the viewport) spanning it — returning its frame. Each round settles the tree,
 * checks the target, then does one momentum-free increment. Stopping only once
 * the target has cleared the entry edge, not on the first sliver, is what keeps
 * a following `tap`/`snapshot` off a half-clipped element. If a round's settled
 * tree — fingerprinted within the scrolled region only — is identical to the
 * previous round's, the container has hit its end (or the anchor scrolls
 * nothing) and the target is accepted wherever it landed: the LAST item sits
 * flush against the far edge and can never clear it, and a genuinely stuck
 * partial can't be improved either. A target already fully on screen returns
 * immediately.
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
    // scope is the `within` region when one is named, otherwise the union of the
    // visible scroll containers under the gesture anchor (not the innermost; see
    // anchorScrollFrames). Only when the tree surfaces none there does the scope
    // stay the whole screen, where a screen-level animator can still mask
    // end-of-scroll and the loop falls back to the iteration cap. Text stays in
    // the fingerprint — a snapping list recycles identical frames with new
    // content, so structure alone would misread real progress as a stuck scroll
    // — which leaves an animating node INSIDE the scrolled content a known
    // limitation.
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
// failure to the scroll search's worst case.
export function offscreenHint(sel: FlowSelector): string {
  return `no visible element matched selector ${describeSelector(sel)} — if it is off-screen, add a scroll-to step before this one`;
}

/**
 * Execute one directive step: the selector-acting ones plus `idle`, which takes
 * no selector because stillness is a property of the whole screen.
 */
export async function runDirective(env: ActionEnv, step: DirectiveStep): Promise<DirectiveOutcome> {
  // Vega is remote-driven — there is no touch input. Fail upfront with
  // authoring guidance instead of a low-level gesture dispatch error after the
  // selector resolves.
  if (
    env.device.platform === "vega" &&
    (step.kind === "tap" ||
      step.kind === "long-press" ||
      step.kind === "type" ||
      step.kind === "scroll-to" ||
      step.kind === "pinch" ||
      step.kind === "rotate")
  ) {
    return {
      ok: false,
      reason: `${step.kind} is a touch directive and Vega is remote-driven — move focus with \`tool: tv-remote\` steps (and type via \`tool: keyboard\`) instead`,
    };
  }
  // Chromium: not "no backend" — CDP can dispatch two-finger touch, but a
  // mouse-driven desktop app has no uniform pinch-zoom mapping (and no
  // rotate-gesture idiom at all) for it to hit.
  if ((step.kind === "pinch" || step.kind === "rotate") && env.device.platform === "chromium") {
    return {
      ok: false,
      reason:
        step.kind === "pinch"
          ? "pinch is unsupported on chromium — desktop apps have no uniform pinch-zoom mapping (they zoom via ctrl+wheel or their own controls); drive the app's zoom UI with tap/keyboard instead"
          : "rotate is unsupported on chromium — desktop apps have no rotate-gesture idiom; drive the app's rotate controls with tap/keyboard instead",
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
    case "idle":
      return waitForIdle(env, step);
    case "scroll-to": {
      const r = await scrollToVisible(env, step.target, step.direction, step.within);
      if (r.aborted) return ABORTED_OUTCOME;
      return { ok: Boolean(r.frame), reason: r.reason };
    }
    case "pinch":
      return runPinch(env, step);
    case "rotate":
      return runRotate(env, step);
  }
}

/**
 * What a selector-less gesture's settle leaves behind: an abort flag, and the
 * warning it owes the step report.
 */
type GestureSettle = { aborted?: true; warning?: string };

/**
 * Settle the screen for a gesture that resolves no selector — raw coordinates,
 * or a centre-anchored `pinch`/`rotate`. A selector target gets its settle from
 * `waitForFrame`; without one there is nothing to resolve, so the gesture would
 * go out against whatever motion was in flight and a coordinate tap could land
 * mid-fling — the very race the settle exists to close.
 *
 * Best-effort where the selector path is not: no frame is being read out of the
 * tree here, so a source outage must not fail this gesture, which would break
 * the escape hatch coordinates exist to be (an element the tree cannot see).
 * Swallowing it is not hiding it — the returned `warning` rides the step report,
 * and every gesture the memo spares carries it, not just the one that proved the
 * outage. Only the outage path warns; a window that expired without converging
 * did settle.
 *
 * It is also the caller `skipProvenOutage` exists for: an app the tree source
 * refuses fails every read (an Apple system app, which flows drive by
 * coordinates for exactly that reason), so every step of such a flow arrives
 * here and would otherwise be charged a window for the same verdict.
 *
 * A platform with no tree source at all is the one case that settles nothing and
 * reports nothing. `ios-remote` is coordinate-driven by necessity —
 * `fetchFlowTree` serves it no tree — so there is no source to be down and no
 * degradation to warn about, and neither remedy a warning could name exists.
 *
 * The other cost is a screen that never holds still: nothing converges, so every
 * selector-less gesture pays the whole window, and the memo buys no relief
 * because a window that read the tree proves no outage. The fingerprint cannot
 * be narrowed the way `scrollToVisible` narrows its own either — that one knows
 * which motion it is waiting on, where a gesture waits on motion of unknown
 * origin that can move what sits under the point without touching it.
 */
async function settleForGesture(env: ActionEnv): Promise<GestureSettle> {
  let warning: string | undefined;
  // A platform with no tree source settles nothing and is warned about nothing;
  // the abort checkpoint below is owed to the gesture either way.
  if (supportsFlowTree(env.device.platform)) {
    try {
      await settleTree(env, { skipProvenOutage: true });
    } catch (err) {
      // tree-source outage — this gesture needs no frame from it, so dispatch
      // anyway. Untyped because a settle has nothing else to throw: every read
      // is validated by `parseDescribeResult` before `treeFingerprint` walks it,
      // so the walk's own unguarded recursion is unreachable on every adapter.
      warning = unsettledGestureWarning(err);
    }
  }
  if (env.signal?.aborted) return { aborted: true };
  return warning !== undefined ? { warning } : {};
}

/** Spread a settle's warning onto an outcome, leaving no `warning: undefined` key behind. */
function warned(settle: { warning?: string }): { warning?: string } {
  return settle.warning !== undefined ? { warning: settle.warning } : {};
}

/** What a gesture reports when an outage left it unsettled, in the source's own words. */
function unsettledGestureWarning(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return (
    `dispatched without settling the screen first: the UI tree could not be read (${reason}), so ` +
    `there was no way to tell whether anything was moving. The gesture went out against whatever ` +
    `was in flight, and one aimed at a moving element can miss it entirely - this step passing ` +
    `says it was sent, not that it landed. Restore the tree source, or put an explicit \`wait:\` ` +
    `in front of gestures that follow a transition.`
  );
}

/**
 * Resolve a gesture target (`tap`/`long-press`) to a normalized point: a
 * selector resolves to its frame centre (settled tree + auto-wait); raw
 * coordinates need no resolution, but still settle before they are used.
 * Coordinates are the fallback for elements with no stable selector.
 *
 * The point is nested rather than returned bare so a `warning` from the settle
 * cannot ride the resolved coordinates into the gesture's tool args.
 */
async function resolveTargetPoint(
  env: ActionEnv,
  target: { selector?: FlowSelector; x?: number; y?: number }
): Promise<{ point: { x: number; y: number }; warning?: string } | { fail: DirectiveOutcome }> {
  if (target.selector) {
    const frame = await waitForFrame(env, target.selector);
    if (frame === "aborted") return { fail: ABORTED_OUTCOME };
    if (!frame) {
      return { fail: { ok: false, reason: offscreenHint(target.selector) } };
    }
    return { point: getDescribeTapPoint(frame) };
  }
  if (typeof target.x === "number" && typeof target.y === "number") {
    const settle = await settleForGesture(env);
    if (settle.aborted) return { fail: ABORTED_OUTCOME };
    return { point: { x: target.x, y: target.y }, ...warned(settle) };
  }
  return { fail: { ok: false, reason: "gesture needs a selector or x/y coordinates" } };
}

/**
 * Tap a resolved target point. `times` rides the gesture-tap tool's
 * `clickCount`: one dispatched multi-tap gesture, never N separate calls, whose
 * RPC gaps could fall outside the OS double-tap window.
 */
async function runTap(
  env: ActionEnv,
  target: { selector?: FlowSelector; x?: number; y?: number; times?: number }
): Promise<DirectiveOutcome> {
  const resolved = await resolveTargetPoint(env, target);
  if ("fail" in resolved) return resolved.fail;
  await invokeOnDevice(env, "gesture-tap", {
    ...resolved.point,
    ...(target.times !== undefined ? { clickCount: target.times } : {}),
  });
  return { ok: true, ...warned(resolved) };
}

/**
 * Long-press defaults comfortably past both platforms' recognizers — iOS
 * UILongPressGestureRecognizer's 500ms minimum and Android's ~400ms long-press
 * timeout — without dragging every step out.
 */
const DEFAULT_LONG_PRESS_MS = 800;

/**
 * Press-and-hold on a target (same resolution as tap) for `duration` ms. Touch
 * platforms dispatch ONE `gesture-custom` train (Down, then Up delayed by the
 * duration) so the hold length is exact; Chromium has no touch, so the closest
 * honest mapping is a mouse press-hold-release (`gesture-drag` with from == to)
 * — apps implementing pointer-based long-press respond, anything else sees a
 * slow click. A desktop context menu is a *right*-click, deliberately not
 * aliased here.
 */
async function runLongPress(
  env: ActionEnv,
  step: { selector?: FlowSelector; x?: number; y?: number; duration?: number }
): Promise<DirectiveOutcome> {
  const resolved = await resolveTargetPoint(env, step);
  if ("fail" in resolved) return resolved.fail;
  const point = resolved.point;
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
  return { ok: true, ...warned(resolved) };
}

/**
 * Pinch-zoom by `scale` centered on a selector's frame (settled tree +
 * auto-wait, like tap) or on the screen center when no selector is given. Both
 * branches settle first; the centre one through {@link settleForGesture}, which
 * is best-effort and adds an abort checkpoint. The scale decomposes into
 * equal-ratio sub-gestures chained with a recognizer reset delay; per
 * sub-gesture, a horizontal and a vertical candidate are built from the
 * axis-matching frame dimension and the better one dispatched (see
 * flow-pinch-geometry). Open-loop by design: there is no "current zoom" to read
 * back, so flows assert on the result, not the multiplier.
 */
async function runPinch(
  env: ActionEnv,
  step: { selector?: FlowSelector; scale: number }
): Promise<DirectiveOutcome> {
  let center = { x: 0.5, y: 0.5 };
  let frame: DescribeFrame | undefined;
  let settle: GestureSettle = {};
  if (step.selector) {
    const resolved = await waitForFrame(env, step.selector);
    if (resolved === "aborted") return ABORTED_OUTCOME;
    if (!resolved) return { ok: false, reason: offscreenHint(step.selector) };
    frame = resolved;
    center = getDescribeTapPoint(resolved);
  } else {
    settle = await settleForGesture(env);
    if (settle.aborted) return ABORTED_OUTCOME;
  }

  const { n, per } = decomposePinch(step.scale);
  // Resolved once per directive; geometry only ever receives guards as data.
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
  return { ok: true, ...warned(settle) };
}

/**
 * Best-effort screen aspect (width / height) for the rotate directive's
 * physical-circle geometry. One dedicated tree read instead of threading
 * dimensions through settleTree/waitForFrame, which leaves the resolution path
 * every other directive shares untouched.
 *
 * The one read {@link ActionEnv.treeOutage} must not spare, unlike the whole
 * settle {@link settleForGesture} skips: this answer is DISPATCHED, not waited
 * on. A stale verdict would degrade a centre rotate on a phone from the
 * edge-safe vertical placement the real aspect picks (Down points at
 * y = 0.278 / 0.722) to the aspect-1 fallback, which puts both fingers 0.48 off
 * centre on whichever axis wins: on iOS the candidates tie and horizontal takes
 * it (x = 0.02 / 0.98, inside the 0.08 side guard), while Android's wider side
 * guards pick vertical (y = 0.02 / 0.98, inside the top/bottom one). Either way
 * both fingers start in a guard.
 *
 * A true verdict costs one failed read instead, which the caller degrades past
 * exactly as it degrades past a skip — but this read carries no budget and no
 * signal, so on iOS it is the 15s hierarchy tier.
 */
async function fetchScreenAspect(env: ActionEnv): Promise<number | undefined> {
  try {
    const { screen } = await readFlowTree(env);
    return screen && screen.width > 0 && screen.height > 0
      ? screen.width / screen.height
      : undefined;
  } catch {
    return undefined; // fail soft: the caller falls back to the legacy ellipse
  }
}

/**
 * Rotate by `by` degrees (+ clockwise) about a selector's frame centre (settled
 * tree + auto-wait, like tap) or the screen centre. Both branches settle first;
 * the centre one through {@link settleForGesture}, which is best-effort and adds
 * an abort checkpoint. One continuous gesture — fingers orbit the fixed centroid
 * at a constant physical radius, so any angle dispatches without decomposition
 * or settle delays, and the angular delta is exact with zero pan/pinch coupling.
 * The initial finger axis is the safer of horizontal and vertical (see
 * flow-rotate-geometry); duration derives from the angle at the fixed ~90°/300ms
 * pace, and `by` is bounded at parse. NOT the `rotate` tool — that changes
 * device orientation.
 */
async function runRotate(
  env: ActionEnv,
  step: { selector?: FlowSelector; by: number }
): Promise<DirectiveOutcome> {
  let center = { x: 0.5, y: 0.5 };
  let frame: DescribeFrame | undefined;
  let settle: GestureSettle = {};
  if (step.selector) {
    const resolved = await waitForFrame(env, step.selector);
    if (resolved === "aborted") return ABORTED_OUTCOME;
    if (!resolved) return { ok: false, reason: offscreenHint(step.selector) };
    frame = resolved;
    center = getDescribeTapPoint(resolved);
  } else {
    settle = await settleForGesture(env);
    if (settle.aborted) return ABORTED_OUTCOME;
  }

  // Unknown aspect (source without dimensions, or a failed read) degrades to
  // aspect 1: the legacy normalized-space orbit — a physical ellipse — rather
  // than a hard error.
  const aspect = await fetchScreenAspect(env);

  // Resolved once per directive; geometry only ever receives guards as data.
  const guards = systemEdgeGuards(env.device);
  const candidates = [
    buildRotateCandidate({
      startAngle: 0,
      center,
      targetSpan: frame?.width,
      guards,
      aspect: aspect ?? 1,
    }),
    buildRotateCandidate({
      startAngle: 90,
      center,
      targetSpan: frame?.height,
      guards,
      aspect: aspect ?? 1,
    }),
  ].filter((c): c is RotateCandidate => c !== undefined);
  const selected = selectRotateCandidate(candidates);
  if (!selected) {
    // The only geometry failure: no positive on-screen orbit radius — never
    // "target too small" (a tiny target is still attempted).
    return {
      ok: false,
      reason: `rotate found no on-screen orbit radius around (${center.x}, ${center.y})`,
    };
  }

  if (env.signal?.aborted) return ABORTED_OUTCOME;
  try {
    await invokeOnDevice(env, "gesture-rotate", {
      centerX: center.x,
      centerY: center.y,
      ...(aspect === undefined
        ? { radius: selected.radiusX }
        : { radiusX: selected.radiusX, radiusY: selected.radiusY }),
      startAngle: selected.startAngle,
      // endAngle > startAngle = clockwise in the tool, matching +by.
      endAngle: selected.startAngle + step.by,
      durationMs: deriveRotateDurationMs(step.by),
    });
  } catch (err) {
    // The tool rejects when cancelled mid-gesture; per ABORTED_OUTCOME that must
    // read as an aborted skip, never a step failure with the tool's message.
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    throw err;
  }
  return { ok: true, ...warned(settle) };
}

/**
 * Resolve `into` → tap to focus → wait for focus to land → type text via the
 * keyboard tool. Unless `submit` is explicitly `false`, a trailing Enter commits
 * the value and dismisses the keyboard so it can't obscure later steps (chained
 * form fields ending in an explicit submit `tap` should pass `submit: false`).
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
  // its own), so a cancelled run can never type into whatever the app has
  // focused after the caller gave up.
  if (env.signal?.aborted) return ABORTED_OUTCOME;
  await invokeOnDevice(env, "keyboard", { text: step.text });
  if (step.submit !== false) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    // Enter goes in its own keyboard call because the tool rejects a combined
    // `{ text, key }` outright (see ../keyboard/index.ts). On an Android TV
    // target this call is also the one that fails: `typeTv` rejects `key`
    // unconditionally, so the text lands and the submit errors. (Android TV is
    // the TV kind that reaches here at all — an Apple TV stops at the focus tap
    // above, whose `gesture-tap` resolves simulator-server, which rejects a tvOS
    // UDID.)
    await invokeOnDevice(env, "keyboard", { key: "enter" });
  }
  return { ok: true };
}

/**
 * Poll a condition against the flow tree until it holds or `timeoutMs` passes.
 * One engine behind both conditional directives — they differ only in budget:
 *
 * - `await` (action-length default, overridable per step via `timeout:`) — a
 *   real wait for a transition. Evaluating it here rather than delegating to the
 *   `await-ui-element` tool gives it the same loose bare-string semantics and
 *   the same full-hierarchy tree source as every other selector directive; the
 *   raw `tool: await-ui-element` step remains the escape hatch for custom
 *   poll/bundleId.
 * - `assert` ({@link DEFAULT_ASSERT_TIMEOUT_MS}) — a correctness check that only
 *   absorbs the latency of an update landing a frame after an action.
 *
 * Mirrors `await-ui-element`'s blind-read guard: an EMPTY tree is not
 * trustworthy evidence for `hidden` (the only condition an empty tree satisfies)
 * when the adapter flagged the read as degraded or the selector had matched on
 * an earlier poll — a transient blank frame mid-navigation must not confirm the
 * element left.
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
  // Post-loop it anchors the dark-tail measurement.
  let lastTrustedReadAt: number | undefined;
  // Whether the LAST completed read attempt was trusted — assigned on every pass
  // through the loop, so post-loop it describes the final poll.
  let lastReadTrusted: boolean;
  let finalPoll = false;

  for (;;) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    try {
      const data = await readFlowTree(env);
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

  // Post-timeout verdict — unknown must not masquerade as false. Three tiers of
  // evidence quality:
  //
  // 1. No trusted read in the whole window: every fetch threw or returned a
  //    blind tree. Such a probe cannot vouch for "condition false" for ANY
  //    condition.
  // 2. Trusted reads existed but the window went dark at the end: the FINAL read
  //    attempt was blind or threw AND the last trusted read lies more than
  //    {@link CONDITION_DARK_TAIL_TOLERANCE_MS} behind the loop's exit. The
  //    condition becoming true is exactly the transition being waited on, so an
  //    observation from before the darkness says nothing about the deadline — a
  //    determinate verdict built from it would let a dying tree source fake a
  //    clean report. `hidden` is held to a stricter bar: there "condition false"
  //    means the element was VISIBLE, and the element leaving is the transition
  //    itself — so ANY untrusted final read leaves gone-ness unconfirmable.
  // 3. Dark tail within the tolerance — a genuine last-poll blip: the trusted
  //    reads still describe the window, so a transient error on the trailing
  //    poll must not flip a clean skip into a hard error. The determinate
  //    verdict stands, with the failed final read appended rather than dropped.
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
    // `hidden` with an evidence gap: the element matched on an earlier trusted
    // read and the FINAL read attempt was blind or threw, so gone-ness can't be
    // confirmed — no blip tolerance here (tier 2's stricter bar). A trusted
    // read WITHOUT a visible match would have satisfied `hidden` inside the
    // loop, so a trusted final read falls through to the determinate "still
    // visible" below with `lastMatches` fresh from that read.
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
  // failed final read is appended, not dropped — and carried on `blipNote`
  // too, for the callers that build their own verdict line rather than printing
  // `reason`. Held bare, brackets added at each use; the settle path's
  // same-named local below is pre-wrapped instead.
  const blipNote =
    !lastReadTrusted && fetchError
      ? `the final poll could not read the UI tree: ${fetchError}`
      : undefined;
  return {
    ok: false,
    reason:
      assertReason(step.condition, step.selector, step.expectedText, step.textMatch, lastMatches) +
      (blipNote ? ` (${blipNote})` : ""),
    ...(blipNote ? { blipNote } : {}),
  };
}

// `await: { idle: true }` asks one question a selector condition cannot: has
// the screen stopped moving? It is deliberately NOT an identity check — a
// dropped tap leaves the source screen perfectly idle — so it belongs next to
// the element check that says WHICH screen, never instead of it.
//
// It never fails a run. A screen that keeps moving is usually a property of the
// app rather than a regression — a video, a shimmer, a carousel — and on Android
// it is also routine: that tree carries live text, so a ticking timer or a
// relative timestamp moves it on every read, where the iOS tree cannot see
// either. Hard-failing on a signal that sensitive, and that different per
// platform, turns one flow file into two verdicts. So a screen that never
// settles is reported as a WARNING on a passing step, naming what to look at.

/**
 * The cadence, the interval count and the defaults live in flow-utils beside the
 * parser, which needs every one of them to reject a wait that could never
 * contain the settle it asks for. Aliased here for readability.
 */
const MIN_STILL_INTERVALS = IDLE_MIN_STILL_INTERVALS;

/**
 * How much budget must be left for another round to be worth STARTING — checked
 * before the poll sleep, so it is spent on the sleep and the round that follows
 * begins with whatever is left. What it rules out is starting a round in the
 * last few milliseconds of the step, where the capture is skipped and the read
 * abandoned, and both absences used to be recorded as facts about the device
 * rather than as the step running out of time. The first round always runs, so
 * an unusually short `timeout:` still buys one honest look.
 */
const MIN_ROUND_BUDGET_MS = IDLE_POLL_MS;

/**
 * The screen settled, but something small on it moved while it did. A spinner is
 * the case that matters: far too small to move the screen (a stock one measured
 * 50-66 changed pixels of a phone capture — see LOCALIZED_MOTION_MIN_PIXELS) and
 * it does not move the tree either, since it spins in a layer without its box
 * ever changing — so both halves of the check agree the screen is at rest while
 * it is still loading.
 *
 * The claim is about the settle being reported, not the whole step: the flag is
 * set by ANY interval of the winning hold and cleared with the hold.
 */
const LOCALIZED_MOTION_WARNING =
  `the screen settled, but a small part of it was still changing while it did — a spinner, a ` +
  `caret, a progress dot. If it is a loading spinner then the screen had not finished loading, ` +
  `and stillness cannot tell those apart: look at what is moving, and gate the next action on ` +
  `the element the loading produces rather than on this settle.`;

/**
 * How long a tree read may go unanswered before the SOURCE is what stopped
 * working, rather than the step running out of time.
 *
 * A read is still given the whole remaining budget — a tree read on a busy
 * screen genuinely takes seconds, and Android's `uiautomator dump` allows itself
 * twenty — so this is not a bound on the read. It is the size of the gap that
 * separates the two reasons a read fails to come back: the last read of a step
 * routinely times out with a couple of hundred milliseconds to its name, and
 * that is the step ending; one abandoned with seconds of budget in hand is a
 * source that has wedged.
 *
 * The budget alone cannot make that split, because every read here is abandoned
 * at the deadline: how much it had is a fact about the step's arithmetic, not
 * about the source. So this is also the margin an abandoned read must beat the
 * SLOWEST read that came back by. A source answering in 2.5s has proved a 2.1s
 * read means nothing; one answering in 100ms has proved a 6.9s read is a wedge.
 */
const HUNG_TREE_READ_MS = 2_000;

/**
 * Evidence-gap bound for the post-loop verdict, and the idle twin of
 * {@link CONDITION_DARK_TAIL_TOLERANCE_MS}: how much of the end of the wait the
 * tree source may have spent failing before "the source stopped answering" is
 * the better account of the window than whatever the screen was doing. A blip is
 * expected mid-settle — the loop restarts the hold and carries on — and the read
 * that happens to END the step is no more meaningful than any other.
 *
 * Counted in ROUNDS rather than in milliseconds, unlike its `waitForCondition`
 * twin, because a round here is not a poll: it is `Promise.all([read, capture])`
 * and lasts `max(read, capture)`, neither half held to a poll —
 * `capturePixelsWithin` grants a capture seconds of its own
 * (PIXEL_CAPTURE_TIMEOUT_MS) and the read gets what is left of the step. A
 * wall-clock tolerance therefore expired whenever a round merely ran long, which
 * a capture backend that is slow but working is enough to do.
 *
 * One unanswered round is what a blip costs. Consecutive ones mean the source
 * went dark, which is the window this step cannot describe.
 */
const IDLE_TOLERATED_DARK_READS = 1;

/** How the last tree read ended. Only `value` licenses a verdict about the app. */
type TreeReadOutcome = "value" | "error" | "timeout" | "blind";

/**
 * Whether a read that ARRIVED still cannot be reasoned from: an empty tree that
 * the reader itself flagged as degraded.
 *
 * The same guard `waitForCondition` applies, minus its `everMatched` term. That
 * one exists so an empty read cannot confirm an element left the screen; this
 * check has no such claim to protect, and an ordinary blank screen has to stay
 * an observation here — it is what resets both holds, and what the "the UI tree
 * stayed empty" warning is about.
 *
 * What is left is the flags the reader attaches when it could not see the app:
 * an unattached Vega automation toolkit surfaces exactly this way
 * (`flow-vega-tree.ts`), and so does an AX service asking to be relaunched.
 */
function isBlindTreeRead(data: DescribeTreeData): boolean {
  return data.tree.children.length === 0 && Boolean(data.hint || data.should_restart);
}

/**
 * Wait until the screen has content and stops moving — in the UI tree AND in the
 * rendered pixels.
 *
 * Both signals are required because each is blind to what the other sees. The
 * tree cannot see presentation-layer motion: an iOS push or modal dismissal
 * commits its hierarchy up front and then animates a layer, and a cross-fade or
 * a scrim moves no node at all. Pixels cannot see a tree that is still churning
 * behind an unchanged-looking surface, and anything genuinely animated forever
 * (a video, a shimmer) would make a pixel-only settle unsatisfiable on a screen
 * the tree calls ready.
 *
 * This is `await-screen-idle`'s question asked against the tree the directives
 * actually resolve against. It returns early the moment the screen is still.
 *
 * A screen that never settles spends the whole timeout and then passes with a
 * warning (see the section note above). Only an unreadable window is a hard
 * stop, and it is `indeterminate` — the check could not run, which is not a
 * verdict about the app.
 *
 * Every verdict is drawn from the LAST round that observed something, never from
 * a latch remembering that the screen was once still.
 */
async function waitForIdle(
  env: ActionEnv,
  step: Extract<FlowStep, { kind: "idle" }>
): Promise<DirectiveOutcome> {
  const timeoutMs = step.timeout ?? IDLE_DEFAULT_TIMEOUT_MS;
  const stableFor = step.stableFor ?? IDLE_DEFAULT_STABLE_FOR_MS;
  // Resolved once: it depends only on the device, and on iOS it costs a
  // runtime probe the capture path memoizes anyway.
  const maskTopFraction = await statusBarMaskFraction(env.device);
  const deadline = Date.now() + timeoutMs;

  // Two hold clocks, because the tree can settle while the pixels have not.
  // The combined one decides; the tree-only one feeds the degraded report at
  // the bottom, for a run whose captures never produced a comparable pair.
  let treeSignature: string | undefined;
  let treeSince = 0;
  let treeStillIntervals = 0;
  let treeSettledAtLastRead = false;
  let previousFrame: PixelFrame | undefined;
  let bothSince = 0;
  let stillIntervals = 0;
  // How long the hold running at the last observed interval had lasted, so the
  // report at the bottom can say what the wait reached rather than asserting it
  // reached nothing — a settle needs an interval COUNT as well as a duration,
  // and the count is the term a short wait usually misses.
  let heldForMs = 0;
  // Small, persistent motion seen across the intervals that produced the current
  // hold. Cleared with the hold, so it only describes the settle being reported.
  let localizedMotionDuringHold = false;

  let readsSucceeded = 0;
  // Reads that came back with a tree AND something in it. Only these can measure
  // an interval, so this — not readsSucceeded — is what the "too few reads to
  // judge" guard at the bottom counts. A blank read is an observation (it resets
  // both holds) but never evidence about motion.
  let contentReads = 0;
  // Definitely assigned: the loop below always completes at least one round,
  // and every arm of that round sets it.
  let lastRead!: TreeReadOutcome;
  let treeErrorMessage: string | undefined;
  // Whether the last read that CAME BACK was a degraded one, and the repair it
  // named if it named one. Both are cleared by a read that carried a tree and
  // survive an abandoned one, exactly as treeErrorMessage does, so a degraded
  // tail is not thrown away by a closing round that merely ran out of budget.
  // `should_restart` arrives without a hint, so the flag cannot be inferred from
  // the message.
  let treeReadBlind = false;
  let blindHint: string | undefined;
  // Rounds since the last read that ANSWERED. Post-loop this is the dark tail. A
  // blank read clears it — it is an observation; see the blank branch.
  let darkReads = 0;
  let treeReadHung = false;
  // The slowest read that came back at all. A source cannot be called wedged
  // over a read cut off in less time than it has already been seen to need.
  let slowestAnsweredReadMs = 0;
  let sawContent = false;
  let pixelsEverMoved = false;
  // Whether two captures were ever put side by side. NOT "a capture failed": the
  // warning below is about a screen no pair could be read from, and one dropped
  // frame in a run of twenty says nothing about that.
  let comparedAPair = false;
  let firstCapture = true;

  for (;;) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    // The tree read is bounded by what is left of the step's budget, the same
    // way the capture is. Without that bound `timeout:` was not an upper bound
    // at all: no describe path takes a signal, and a wedged one (a hung
    // ViewInspector RPC, an `adb` that has stopped answering) ran the round past
    // the deadline.
    const roundBudget = Math.max(1, deadline - Date.now());
    const roundStartedAt = Date.now();
    // Timed on the read itself rather than on the round: a round is the SLOWER
    // of its two halves, and the hung-source check compares how long this source
    // takes to answer, not how long the capture beside it took.
    let answeredReadMs: number | undefined;
    // Read both signals from as close to one instant as possible: they describe
    // the same screen, and any gap between them is a window motion hides in.
    // They travel over different channels, so serializing them would double the
    // round without buying anything.
    const [read, frame] = await Promise.all([
      settleWithin(readFlowTree(env), roundBudget, env.signal).then((r) => {
        answeredReadMs = Date.now() - roundStartedAt;
        return r;
      }),
      capturePixelsWithin(env, deadline, firstCapture),
    ]);
    firstCapture = false;
    // A capture abandoned by an abort comes back indistinguishable from one that
    // failed, and no verdict may be derived from a run that was cancelled.
    if (env.signal?.aborted || read.type === "aborted") return ABORTED_OUTCOME;

    // Every read that CAME BACK — with a tree or with a failure — is evidence
    // of how slow this source can be while still answering. That is the only
    // yardstick an abandoned read can be measured against; see
    // HUNG_TREE_READ_MS.
    if (read.type !== "timeout" && answeredReadMs !== undefined) {
      slowestAnsweredReadMs = Math.max(slowestAnsweredReadMs, answeredReadMs);
    }

    if (read.type === "timeout") {
      // The read did not come back inside the round. That is the absence of an
      // observation, not an observation: it neither refutes the last known
      // tree state nor stands in for one, so the hold state is left as it was
      // and the bottom decides what, if anything, it means.
      lastRead = "timeout";
      darkReads += 1;
      // ...except for one thing it may say. A read abandoned with seconds of
      // budget left, AND with seconds more than this source has ever needed to
      // answer, is a source that has wedged rather than a step that ran out of
      // time. A read cut off before it beat the source's own slowest answer
      // proves nothing about it.
      if (
        roundBudget >= HUNG_TREE_READ_MS &&
        roundBudget > slowestAnsweredReadMs + HUNG_TREE_READ_MS
      ) {
        treeReadHung = true;
      }
    } else if (read.type === "value" && isBlindTreeRead(read.value)) {
      // A read that arrived but cannot be reasoned from. Counted with the dark
      // reads, not with the answers: the source responded, but not about the
      // app. Like an abandoned read it is the absence of an observation, so the
      // hold state is left as it was.
      lastRead = "blind";
      darkReads += 1;
      treeReadBlind = true;
      blindHint = read.value.hint;
    } else if (read.type === "error") {
      // A tree-source blip mid-animation is expected; keep polling. Only its
      // presence on the LAST read is reportable.
      lastRead = "error";
      darkReads += 1;
      treeErrorMessage = read.error;
      treeSignature = undefined;
      previousFrame = undefined;
      treeSince = 0;
      treeStillIntervals = 0;
      treeSettledAtLastRead = false;
      bothSince = 0;
      stillIntervals = 0;
    } else {
      lastRead = "value";
      readsSucceeded += 1;
      darkReads = 0;
      treeErrorMessage = undefined;
      treeReadBlind = false;
      blindHint = undefined;
      // It answered, so whatever wedged it has cleared.
      treeReadHung = false;
      const tree = read.value.tree;
      if (tree.children.length === 0) {
        // Blank or still loading, and undegraded — the reader vouches for the
        // emptiness (the branch above took the reads it does not). Never
        // "settled", and it resets both holds. Unlike a failed read this IS an
        // observation, so it also clears the tree-only verdict.
        treeSignature = undefined;
        previousFrame = undefined;
        treeSince = 0;
        treeStillIntervals = 0;
        treeSettledAtLastRead = false;
        bothSince = 0;
        stillIntervals = 0;
      } else {
        sawContent = true;
        contentReads += 1;
        const signature = treeFingerprint(tree);
        const now = Date.now();

        // Stillness is a property of an INTERVAL, so no verdict comes from one
        // observation — and, per MIN_STILL_INTERVALS, none from one interval
        // either. `stableFor: 0` therefore still means three reads: a single
        // agreeing pair can be two points of an animation that reversed between
        // them.
        const treeHeld = signature === treeSignature;
        treeSignature = signature;
        if (!treeHeld) {
          treeSince = now;
          treeStillIntervals = 0;
        } else {
          treeStillIntervals += 1;
        }
        treeSettledAtLastRead =
          treeStillIntervals >= MIN_STILL_INTERVALS && now - treeSince >= stableFor;

        // A missing frame is the ABSENCE of visual evidence — evidence neither of
        // stillness nor of motion. Hence three states rather than two: `true` a
        // compared pair held, `false` a compared pair moved, `undefined` no pair
        // to compare. Only the middle one may break the hold. Reading the
        // absence as `false` made a dropped frame DESTROY the hold rather than
        // merely fail to extend it, so a backend dropping the odd frame could
        // serve no hold longer than the gap between drops.
        let pixelsHeld: boolean | undefined;
        let localizedThisInterval = false;
        if (frame !== undefined) {
          if (previousFrame !== undefined) {
            comparedAPair = true;
            const change = comparePixels(previousFrame, frame, maskTopFraction);
            if (change === "moving") {
              pixelsEverMoved = true;
              pixelsHeld = false;
            } else {
              pixelsHeld = true;
              localizedThisInterval = change === "localized";
            }
          }
          // Only a frame that arrived replaces the reference. Overwriting it
          // with `undefined` on a missed capture cost the NEXT round its
          // comparison too, so one slow capture blinded two intervals. Holding
          // the last good frame asks the same question across the gap, over a
          // longer interval.
          previousFrame = frame;
        }

        if (!treeHeld || pixelsHeld === false) {
          // Something was seen to move. Only an observation breaks the hold.
          bothSince = now;
          stillIntervals = 0;
          heldForMs = 0;
          localizedMotionDuringHold = false;
        } else if (pixelsHeld === true) {
          stillIntervals += 1;
          heldForMs = now - bothSince;
          if (localizedThisInterval) localizedMotionDuringHold = true;
          if (stillIntervals >= MIN_STILL_INTERVALS && heldForMs >= stableFor) {
            return localizedMotionDuringHold
              ? { ok: true, warning: LOCALIZED_MOTION_WARNING }
              : { ok: true };
          }
        }
        // Otherwise the tree held and no pair could be compared: this round
        // measured no interval and refutes none, so the hold state is left as it
        // was. It cannot settle the screen on its own — an interval is only ever
        // counted from a compared pair — so a run whose captures all go missing
        // still ends at the bottom, never in a pass.
      }
    }

    if (env.signal?.aborted) return ABORTED_OUTCOME;
    const left = deadline - Date.now();
    if (left < MIN_ROUND_BUDGET_MS) break;
    if (!(await sleepOrAbort(Math.min(IDLE_POLL_MS, left), env.signal))) return ABORTED_OUTCOME;
  }

  // An unreadable window is never a verdict about the app. Which flavour of
  // unreadable it was decides the repair, so they stay apart.
  const unreadable = (underlying: string): DirectiveOutcome => ({
    ok: false,
    indeterminate: true,
    // The underlying reader reports an instrumentation failure, whose remedy
    // (relaunch the app) is the wrong repair for the commonest cause here: the
    // app is simply not in the foreground, which reads exactly the same from the
    // tree source. Name that first.
    reason:
      `could not read the UI tree while waiting for the screen to settle — check the app is ` +
      `still in the foreground (a backgrounded app reads the same as an uninstrumented one). ` +
      `Underlying error: ${underlying}`,
  });

  // The other flavour: the source answered, and said it could not see the app.
  // Its own repair is the right one here — an unattached toolkit or a dropped AX
  // service is exactly what this shape means — so it is quoted, not replaced.
  const degraded = (): DirectiveOutcome => ({
    ok: false,
    indeterminate: true,
    reason:
      `the UI tree read back empty and degraded while waiting for the screen to settle, so the ` +
      `screen was never observed — this is the reader reporting it could not see the app, not ` +
      `the app rendering nothing` +
      (blindHint === undefined ? "" : `. ${blindHint}`),
  });

  if (readsSucceeded === 0) {
    if (treeErrorMessage !== undefined) return unreadable(treeErrorMessage);
    if (treeReadBlind) return degraded();
    return {
      ok: false,
      indeterminate: true,
      reason:
        `the tree source never answered within the step's ${timeoutMs}ms — raise this step's ` +
        `\`timeout:\` if it is merely slow (a tree read on a busy screen can take seconds), or ` +
        `repair it if it has stopped answering altogether`,
    };
  }
  // Reads worked, then stopped: a backgrounded app, a dropped instrumentation
  // session. One early success does not license a verdict drawn from a window
  // that went dark afterwards. (A read that merely ran out of budget is NOT this
  // case — it is the step ending, and the evidence below still stands.)
  //
  // Measured as a tail, not as a single read: the source failing on the last
  // poll and the source having stopped answering are different windows, and only
  // the second is unreadable. See IDLE_TOLERATED_DARK_READS.
  //
  // The tail is what decides, NOT how its last round happened to end: a round
  // that runs out of budget mid-read ends as a `timeout` however dead the source
  // is, so requiring `error` here would discard the whole accumulated tail.
  // `treeErrorMessage` survives an abandoned read and is cleared by a successful
  // one, so it means exactly "the last read that came back did so as a failure".
  if (treeErrorMessage !== undefined && darkReads > IDLE_TOLERATED_DARK_READS) {
    return unreadable(treeErrorMessage);
  }
  // A degraded tail is the same window, reached the other way: the reads kept
  // arriving and kept saying nothing about the app. One is a blip like any other
  // and rides out on the same tolerance.
  if (treeReadBlind && darkReads > IDLE_TOLERATED_DARK_READS) {
    return degraded();
  }
  // The same window going dark the other way: the source answered, then stopped
  // answering with seconds of budget still in hand. A failing read has a
  // dedicated error above; a HANGING one would otherwise fall through to the
  // motion warning and tell the author a frozen screen was a carousel.
  if (lastRead === "timeout" && treeReadHung) {
    return {
      ok: false,
      indeterminate: true,
      reason:
        `the UI tree source answered and then stopped: a read given at least ` +
        `${HUNG_TREE_READ_MS}ms never came back, so the screen could not be observed for the ` +
        `rest of the wait — check the app is still in the foreground and responding (a wedged ` +
        `app reads the same as a backgrounded one)`,
    };
  }
  // A tolerated blip is not a silently dropped error: whichever warning below
  // describes the window carries the failed read with it, the way
  // waitForCondition appends its own. (The tree-only settle cannot be reached
  // with a failed final read — that read cleared `treeSettledAtLastRead` — so it
  // is left without a note it could never print.)
  const blipNote =
    treeErrorMessage !== undefined
      ? ` (the last read that came back failed: ${treeErrorMessage})`
      : "";

  // Readable throughout and never once carrying content: the screen rendered
  // nothing, which is not the same claim as "it never stopped moving".
  //
  // A warning, not a stop. The tree read back fine, and it is not always the
  // app's fault: a screen legitimately renders no accessible content (a bare
  // canvas, a video surface, a splash image), and stopping the flow there would
  // take every later step with it, including the element check that would have
  // said what was actually wrong.
  if (!sawContent) {
    return {
      ok: true,
      warning:
        `the UI tree stayed empty for ${timeoutMs}ms — the screen never rendered content, so ` +
        `there was nothing to settle. If the screen is meant to render accessible content, this ` +
        `is where it did not; if it is a canvas or a video surface, it has none to read. Gate ` +
        `the next action on an element check either way.` +
        blipNote,
    };
  }
  // Too few reads to have judged anything. A settle needs three of them spanning
  // two intervals, so a step that got fewer has no evidence either way. The
  // parser rejects a `timeout:` too short to fit a settle, so what reaches here
  // is a source slow enough to eat the wait, or a window blank for most of it.
  //
  // Counted in reads that CARRIED CONTENT, not in reads that answered: a blank
  // one resets both holds and measures no interval, and counting it let a window
  // blank for all but its last two reads sail past this guard and assert instead
  // that the screen never held still — motion claimed from one measured
  // interval.
  if (contentReads <= MIN_STILL_INTERVALS) {
    return {
      ok: true,
      warning:
        `the screen came back with content on ${contentReads} read` +
        `${contentReads === 1 ? "" : "s"} in ${timeoutMs}ms, and a settle takes ` +
        `${MIN_STILL_INTERVALS + 1} of them spanning ${MIN_STILL_INTERVALS} ${IDLE_POLL_MS}ms ` +
        `polls — so this step ended without ever being able to tell whether the screen was ` +
        `moving. Raise its \`timeout:\`, and gate the next action on a stable element rather ` +
        `than on stillness.` +
        blipNote,
    };
  }
  // The tree was settled as of the last read and no pair of captures ever showed
  // motion, yet the combined hold never completed. Once a pair has been compared
  // this is unreachable: a pair either agrees — and the tree was holding, so the
  // hold would have run — or disagrees, which sets pixelsEverMoved. So a run
  // that never got a pair is what is left, and it is required here rather than
  // assumed: "never got a PAIR", not "a capture failed once", since a latch set
  // by any single drop would fire for authors whose every compared pair read
  // still.
  //
  // The hierarchy genuinely held still, so this is a pass; half of the proof is
  // missing, so it is a warned one.
  if (treeSettledAtLastRead && !pixelsEverMoved && !comparedAPair) {
    return {
      ok: true,
      warning:
        `settled on the UI tree alone — this screen could not be screenshotted on enough polls ` +
        `to compare a pair of them, so animation that moves pixels without moving nodes (a push, ` +
        `a fade, a dismissing modal) was not waited out. Follow this with the element check the ` +
        `next step actually needs.`,
    };
  }
  // The wait ended while a hold was running. A settle needs BOTH an interval
  // count and a duration, so naming only the duration reported a screen that had
  // demonstrably held still as one that never did — and with `stableFor: 0` it
  // read as "never held still for 0ms", which nothing can fail. Name the term
  // that was actually short: the wait ran out, which is not the same as the
  // screen never stopping.
  if (stillIntervals > 0) {
    const shortOf =
      stillIntervals < MIN_STILL_INTERVALS
        ? `a settle takes ${MIN_STILL_INTERVALS} consecutive ones — a single agreeing interval ` +
          `can be two samples either side of an animation's turning point`
        : `the hold asks for ${stableFor}ms of it`;
    return {
      ok: true,
      warning:
        `the screen was still for the last ${heldForMs}ms of the ${timeoutMs}ms wait, over ` +
        `${stillIntervals} ${IDLE_POLL_MS}ms interval${stillIntervals === 1 ? "" : "s"} — but ` +
        `${shortOf}, so the wait ran out before the settle could be confirmed rather than ` +
        `because the screen never stopped. Raise this step's \`timeout:\`, and gate the next ` +
        `action on a stable element rather than on stillness.` +
        blipNote,
    };
  }
  return {
    ok: true,
    warning:
      `the screen never held still for ${MIN_STILL_INTERVALS} consecutive ${IDLE_POLL_MS}ms ` +
      `intervals${stableFor > 0 ? ` spanning ${stableFor}ms` : ""} within ${timeoutMs}ms, and ` +
      `was moving again on the last one, so this step went ahead without waiting it out. Either ` +
      `something on it never stops (a video, a looping animation, a carousel, live-updating ` +
      `text) or the screen never finished loading. Look at what is moving, and make sure the ` +
      `next action is gated on a stable element rather than on stillness.` +
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
      // Reached only when the final read was trusted (waitForCondition returns
      // indeterminate when it was blind or threw), and a trusted read without a
      // visible match satisfies `hidden` inside the poll loop — so `matches`
      // holds what that read saw: the element, still on screen.
      return `an element matching ${sel} was still visible`;
    case "text": {
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      if (!first) return `no element matched selector ${sel}`;
      const wanted = describeTextExpectation(expectedText, textMatch, "infinitive");
      // The check accepts the element's own label/value as well as its hoisted
      // subtree text (see evaluateCondition), so quote both when they differ.
      const shown = assertText(first);
      const own = nodeText(first);
      const ownNote = own && own !== shown ? ` (own text "${own}")` : "";
      return `element matched ${sel} but its text was "${shown}"${ownNote} (wanted to ${wanted})`;
    }
    default:
      return `assertion failed for selector ${sel}`;
  }
}
