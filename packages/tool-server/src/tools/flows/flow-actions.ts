import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import {
  getDescribeTapPoint,
  type DescribeFrame,
  type DescribeNode,
  type DescribeSource,
  type DescribeTreeData,
} from "../describe/contract";
import {
  selectorToNode,
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

/** Everything a directive needs to act on the run's device. */
export interface ActionEnv {
  registry: Registry;
  ctx?: ToolContext;
  device: DeviceInfo;
  signal?: AbortSignal;
  /**
   * Bundle id of the last successful native `launch:` in this RUN — nested
   * `run:` flows share it (ExecState is per-run, so a nested launch updates
   * the whole run's hint, matching "a nested e2e launch restarts its app").
   * Cleared by `tool:` steps that can change the foreground app (launch-app,
   * restart-app, open-url, button, reinstall-app). iOS tree reads use it ONLY
   * as an arbiter when target auto-resolution itself times out — see
   * `queryFullHierarchyTree` — so foreground-likeness guards keep firing
   * whenever the app answers at all.
   */
  launchedNativeApp?: string;
  /**
   * Run-scoped memo of a tree source that answered nothing: set by a
   * {@link settleTree} that failed every read attempt, cleared by the next
   * DIRECTIVE read that comes back. One holder per run (built in flow-run's
   * ExecState and shared by every `deviceEnv`), so the evidence one step
   * gathered is the evidence the next one acts on.
   *
   * A `tool:` step's read is not one of those: it goes through `invokeSubTool`
   * and never reaches {@link readFlowTree}, so a run can carry a green
   * `native-full-hierarchy` - the same RPC flow-ios-tree issues - or a green
   * `describe` (the same source outright on Android, Chromium and Vega; the AX
   * tree only on iOS) and still skip later gesture settles. Nor is the clear
   * ordered against the step that is running: `idle` hands its read to
   * `settleWithin` and stops waiting at the round budget, so that read can land
   * during a later step and retire a verdict minted after it was issued. Safe
   * direction - that only ever costs a later gesture a settle it would have
   * skipped - but it is a clear by arrival, not by sequence.
   *
   * Only {@link settleForGesture} READS it, and only to skip a settle it has
   * already been shown is unaffordable - never a read whose answer is
   * dispatched rather than waited on, which is why {@link fetchScreenAspect}
   * does not consult it. The skip is not silent: the gesture warns its step
   * report that it dispatched unsettled, so the memo never makes an outage
   * cheaper to miss than it was to prove. It is written by the one place that
   * can prove a source dead (a {@link settleTree} that failed every read
   * attempt), whichever directive asked for that settle. `waitForFrame` and
   * `scrollToVisible` error the step on it, so a verdict of theirs is never
   * spent; `runSnapshot` captures pixels regardless and `VisualOutcome` has
   * no `warning` field, so its step passes in silence: the outage surfaces on
   * the gesture that spends the verdict, or not at all if none follows.
   *
   * That same silence keeps `runSnapshot` deliberately off the reading side,
   * though not on {@link fetchScreenAspect}'s grounds, since a snapshot's
   * settle IS waited on. A capture taken on a stale verdict lands as a
   * mid-animation pixel mismatch that reads as a visual regression, with
   * nothing to say the screen was never settled: being wrong there costs a
   * step, where the gesture risks only a settle. The price is that on a source
   * failing by timeout, every snapshot step re-buys the whole settle, window
   * and floor reads alike, two reads where the window alone ended on one. In
   * exchange the settle reads through {@link readFlowTree}, so a snapshot
   * re-tests the verdict instead of trusting it, and with a rotate's
   * {@link fetchScreenAspect} it is one of the two reads left that can retire a
   * wrong one in a flow of nothing but snapshots and coordinate gestures.
   *
   * It is cleared by {@link readFlowTree}, which every directive's reads go
   * through, since a read that came back is evidence of health whichever
   * directive asked for it. A relaunch clears it too, whether spelled `launch`
   * or as one of flow-run's `FOREGROUND_CHANGING_TOOLS`: it is the repair the
   * commonest of these errors asks for, and no read need follow it before a
   * gesture does. So does a nested orchestrator step, which can do either out
   * of this holder's sight. Absent for a caller that builds an `ActionEnv` by
   * hand, which simply leaves every settle on its own budget.
   *
   * The write carries the device it was proven against: a verdict about a
   * device the run has left says nothing about the one it moved onto (a
   * chromium `launch` boots its own). Belt-and-braces today - the one mid-run
   * move is behind `runLaunch`, which clears the verdict first - but it keeps
   * the property from resting on where that clear sits in another file. The
   * clear is deliberately NOT keyed: it only ever costs a later gesture a
   * settle it would otherwise have skipped, and that is the side to err on.
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
   * The condition could not be evaluated — unknown, not false: the window
   * never produced a trustworthy read (every fetch threw or returned a
   * blind/degraded tree), or a `hidden` check ended on a blind or failed
   * read after the element had matched. Read by the `when:` guard probe,
   * which must error rather than silently skip a block a broken tree source
   * can't vouch for; a plain `assert` reports it as an ordinary failure. An
   * `idle` step is the exception — it has no condition to fall back on, so the
   * runner scores its indeterminate outcome `error` rather than `fail`.
   */
  indeterminate?: boolean;
  /**
   * The step passed, but the WAY it passed weakens it as proof — carried into
   * the step report so the author is told what the green actually bought.
   */
  warning?: string;
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

/** The condition/action steps {@link runDirective} handles. */
export type DirectiveStep = Extract<
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

/**
 * {@link invokeOnDevice}, reclassifying a rejection that coincides with a
 * cancelled run as the aborted skip {@link ABORTED_OUTCOME} defines, rather than
 * a step failure quoting the tool.
 *
 * Four call sites over three tools — `gesture-rotate` in `runRotate`, and
 * `gesture-tap` plus both `keyboard` dispatches in `runType` — reaching it from
 * opposite directions.
 *
 * `gesture-rotate` DOES honour the signal: it polls `ctx?.signal?.aborted` every
 * frame, lifts the fingers and throws a named `AbortError`. Without this wrapper
 * `runRotate` would report that deliberate unwind as a failed step.
 *
 * `keyboard` honours it too, on all three platforms `clear` supports, but not
 * to the same depth. Only iOS checks it BETWEEN keypresses:
 * `keyboard/platforms/ios.ts` forwards `options?.signal` into
 * `simulator-server-keys`, which calls `signal?.throwIfAborted()` per key.
 * Android and Chromium check it ONCE, as the call's turn on the per-device
 * chain comes round (`keyboard/platforms/android.ts`, `.../chromium.ts`), and
 * neither `runAndroidPhoneType` nor `runChromium` takes a signal at all —
 * Android's own comment says so outright, `adb shell input` not being
 * cancellable. Concretely: cancel a run mid-`type` on Android or Chromium and
 * the whole text is still typed out, a resolved `{{secret:…}}` included. An
 * abort-driven rejection is still the DESIGNED outcome on every one of them,
 * which is what this wrapper classifies.
 *
 * `gesture-tap` is the one that honours nothing. Not because its handlers
 * discard the context — it has no platform handlers, and `execute(services,
 * params)` (`gesture-tap/index.ts`) declares no context parameter, so the
 * signal never arrives. Its dispatch therefore rejects only for an unrelated
 * reason that happens to land inside a cancelled window: an `adb shell input`
 * timeout, a simulator-server socket error. Rarer, but the classification still
 * has to be the skip, because the alternative is a report blaming the tool for
 * a run the caller cancelled — and in `runType`'s case a report whose verdict
 * depended on which of its three dispatches happened to be in flight.
 *
 * (Cancelling a run does NOT tear down the transport under an in-flight call.
 * Flow-run's Chromium teardown is run-level, in the `finally` after `execSteps`
 * settles.)
 *
 * `runLaunch` handles the same case differently on purpose and is NOT a caller:
 * it returns a `restart-app failed: …` outcome rather than rethrowing, so
 * routing it through here would change its behaviour.
 *
 * Returns false when the run was cancelled; a genuine tool error still throws.
 */
async function dispatchOrAbort(
  env: ActionEnv,
  tool: string,
  args: Record<string, unknown>
): Promise<boolean> {
  try {
    await invokeOnDevice(env, tool, args);
  } catch (err) {
    if (env.signal?.aborted) return false;
    throw err;
  }
  return true;
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
// the chromium DOM walker). A source outside this set is one whose focus
// reporting the `type` directive has no use for, so polling would burn the
// whole timeout on every type step — skip the focus wait there instead.
//
// Not the same as "cannot report focus". Vega's toolkit page source DOES set it
// (`describe/platforms/vega/source-parser.ts`, preserved through
// `flow-vega-tree`); it is outside the set because `runDirective` refuses
// `type` on Vega before any of this runs, so the flag has no reader.
const FOCUS_REPORTING_SOURCES: ReadonlySet<DescribeSource> = new Set([
  "native-devtools",
  "android-devtools",
  "cdp-dom",
]);

// Settle detection: re-read the tree until two consecutive reads match, so a tap
// never lands mid-fling and a resolved frame can't go stale before we act.
const SETTLE_POLL_MS = 250;
/**
 * How long that re-reading gets. Exported for flow-settle-min-reads.test.ts,
 * which sizes its slow reads past this window: a hand-copied number there would
 * survive this one being raised above it, and the read counts it prices would
 * quietly stop measuring the floor below.
 */
export const SETTLE_TIMEOUT_MS = 3000;

// Read attempts every settle makes before it may conclude anything, enforced
// even once the window has closed. A read can fail by TIMING OUT, and every
// tree source's RPC timeout outlasts the 3s window: 5s is the shortest tier any
// of them allows, and a whole read chains several of those (an iOS read spends
// up to 5s resolving the target app before a 15s `getFullHierarchy`), so the
// window fits only one such read. Without a floor, "every read in the window
// failed", which the throw below reports as a tree-source outage, would
// collapse into "the first read was slow", erroring a step on one transient
// blip with no retry at all. The second read is not bounded by the window
// either, so a wedged source costs two full reads and tens of seconds, and a
// source that answers slowly pays a second read where it used to end on one.
// Slower than the window is not the exceptional case: `HUNG_TREE_READ_MS`
// reasons from 5400ms Android reads, so ending a window on a single read is
// the ordinary outcome there and the second read an ordinary cost, not a
// degraded one. `scroll-to` multiplies that: it settles once per round,
// bounded by `MAX_SCROLL_ITERATIONS` rather than a wall clock, so the added
// read lands on every round and a slow source turns one step's tens of seconds
// into minutes.
// `await`/`assert` never had this hole: `waitForCondition` takes a poll at its
// deadline unconditionally, however many reads preceded it. The floor here is
// narrower, firing only when the window closed on fewer than two reads, but it
// covers the same case: a first read that outlasts the window on its own.
const SETTLE_MIN_READS = 2;

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

// The same bound for `waitForFocus`, in two forms, because either alone leaves
// the outage refusal open.
//
// Counted in consecutive failed polls, one poll is the genuine last-poll blip
// and more than one is darkness — the rule above, restated for a loop whose
// polls each cost a whole tree read (an android-devtools `getHierarchy`, a CDP
// DOM walk), so a device that is merely slow is not read as an outage.
//
// That counter can only be REACHED by failures that come back fast, which is
// not how a tree source usually goes down. A read that hangs is bounded by its
// own transport timeout — 15s on Android's `getHierarchy`, 10s per CDP call,
// 5s per ViewInspector RPC — every one of them longer than this whole focus
// window, so a single hang ends the window with the counter at 1 and the
// verdict fell through to "unobservable", the one non-confirmed outcome
// `runType` dispatches a destructive clear on. Reproduced on Chrome 151: a page
// that blocks its own main thread for 12s from the focusing tap's `mousedown`
// took the step from a refusal to a pass that emptied and rewrote a field the
// step never named.
//
// So darkness is ALSO measured in elapsed milliseconds, from the moment the
// first unanswered read STARTED — the span the window learned nothing in,
// whether that was spent on one hang or on several quick throws. Same tolerance
// as `waitForCondition`'s, for the same reason.
const FOCUS_DARK_TAIL_POLLS = 2;
const FOCUS_DARK_TAIL_TOLERANCE_MS = POLL_INTERVAL_MS * 2;

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
 *
 * Every relational scope (`within`/`after`/`next`) expands recursively: each
 * level's alternatives cross-combine (a bare-string `within: foo` contributes
 * an identifier pass and a text pass, a map level contributes itself), ordered
 * identifier-first at every level so the doctrine matches the top level's. The
 * returned selectors are fully strict — no `loose` flag survives at any depth.
 *
 * The product is exponential in the number of BARE-STRING scopes, which is what
 * bounds it: only a bare string is loose, a bare string carries no scope of its
 * own, and the parser caps a selector's whole relation tree at
 * MAX_SELECTOR_SCOPES — so the worst case is a few dozen passes and a
 * hand-authored selector is one or two. (That cap is a tree-SIZE bound for
 * exactly this reason: a depth bound alone would admit 3^depth loose leaves.)
 *
 * `any` is dropped here: it is the flow-side marker that legitimizes a
 * field-less selector, and a field-less selector is already what the match
 * engine reads as "every element".
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

/**
 * Identifier-first-then-text NODE resolution for a (possibly loose) selector —
 * the element a directive acts on.
 */
function flowSelectorToNode(tree: DescribeNode, sel: FlowSelector): DescribeNode | undefined {
  for (const s of selectorAlternatives(sel)) {
    const node = selectorToNode(tree, s);
    if (node) return node;
  }
  return undefined;
}

/**
 * The run's outage verdict, if one was proven against the device in hand: a
 * verdict about a device the run has left says nothing about this one (see
 * {@link ActionEnv.treeOutage}).
 */
function provenTreeOutage(env: ActionEnv): Error | undefined {
  const proven = env.treeOutage?.proven;
  return proven && proven.deviceId === env.device.id ? proven.error : undefined;
}

/**
 * Every tree read a directive makes, so that a read which comes back clears
 * {@link ActionEnv.treeOutage} whichever directive asked for it. Routing them
 * all through here is what keeps the memo's claim honest: `await`/`assert`,
 * `idle`'s read and the rotate aspect read never settle, so a clear living in
 * {@link settleTree} alone would let a run read the tree successfully, over and
 * over, and still have every later coordinate gesture skip its settle on the
 * strength of one old failure.
 *
 * The `type` focus wait routes here for uniformity but can never be the read
 * that clears a verdict: it runs only once {@link waitForFrame} has resolved a
 * frame, which takes a settle that read the tree - and that read already
 * cleared it.
 */
function readFlowTree(env: ActionEnv): Promise<DescribeTreeData> {
  return fetchFlowTree(env.registry, env.device, env.launchedNativeApp).then((data) => {
    if (env.treeOutage) env.treeOutage.proven = undefined;
    return data;
  });
}

/**
 * {@link flowSelectorToNode}'s frame. One resolver behind both, because a
 * `type` step uses both halves at once: this frame is what gets TAPPED, and the
 * node is what the focus check judges identity against. A second, unranked pick
 * made them disagree on the everyday label-above-input shape — the tap landed
 * on the input while the identity check resolved to the label above it, so the
 * check could never match: a `clear` hard-failed pointing at a selector that
 * was already resolving correctly, and a plain `type` burned the whole focus
 * timeout on every step.
 */
function flowSelectorToFrame(tree: DescribeNode, sel: FlowSelector): DescribeFrame | undefined {
  return flowSelectorToNode(tree, sel)?.frame;
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
 * (e.g. native devtools disconnected mid-run — `fetchFlowTree` refuses to
 * degrade to a trimmed tree), not a mid-animation blip, and swallowing it would
 * convert the outage into a misleading "element not found" downstream. The
 * throw lands in the step's structured report via `execLeafStep`'s catch.
 *
 * "Every attempt" is at least {@link SETTLE_MIN_READS} of them: the deadline
 * bounds the polling, never the number of reads taken, so a read slow enough to
 * outlast the window on its own is retried rather than treated as the whole
 * evidence. The price lands on the best-effort return: if that retry then
 * fails, `prevTree` is the first read's tree handed back a read-duration later
 * (bounded by the tree source's own RPC ceiling), older than what the bare
 * deadline would have returned. Paid for what the retry buys, which differs by
 * branch. After a failed first read it buys evidence: the outage throw rests on
 * two failed attempts rather than on one slow read, and a retry that succeeds
 * there still returns a lone tree matched against nothing. After a successful
 * first read it buys a fresher sample, since the retry's tree comes back
 * whether or not the fingerprints match, and with it the settle's only chance
 * to converge. The best-effort return also reaches `snapshot: { cropOn }`
 * through {@link waitForFrame}, where the whole retry widens the gap between
 * the read the crop rectangle comes from and the capture, so the crop can be
 * measured against a layout the pixels no longer show.
 *
 * `skipProvenOutage` rethrows {@link ActionEnv.treeOutage} instead of buying
 * that whole settle again, window and floor reads alike. Not a shorter budget:
 * a threshold low enough to spare a source serving no tree at all would also
 * abandon the mid-navigation blip the retry above exists for. But the memo is a
 * prediction: one settle mints it and nothing re-tests it. Being wrong costs a
 * settle, not a step: {@link settleForGesture} swallows the throw - and says
 * so, warning every gesture it spares, so a run whose prediction was wrong
 * reports which greens went out unsettled. Any directive read that comes back
 * retires it, as does a relaunch.
 *
 * What it costs: an outage that failed every read attempt, in a run that then
 * never reads the tree again and never relaunches, leaves later gestures
 * unsettled even once it clears. That is a flow of nothing but coordinate
 * gestures giving up a best-effort settle it never had before this directive
 * existed, against every one of those gestures otherwise paying a whole settle,
 * window and floor reads alike, for a tree that is not coming.
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
    // The signal bounds the wait; nothing else does. A budget of what is left of
    // the window would fail the slow cold start #778 raised
    // `ViewHierarchy.getFullHierarchy` to a 15s RPC tier to ride out, so the
    // read keeps its own tier and only a cancelled run stops us waiting on it.
    const read = await settleWithin(readFlowTree(env), undefined, env.signal);
    let tree: DescribeNode | undefined;
    if (read.type === "value") {
      tree = read.value.tree;
    } else if (read.type === "error") {
      // transient describe failure mid-navigation — retry until the deadline
      lastError = read.cause;
    }
    reads += 1;
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
 * Exported for `snapshot: { cropOn }` (flow-visual.ts), which resolves the
 * crop element's frame with the same settle + auto-wait the directives get.
 */
export async function waitForFrame(
  env: ActionEnv,
  selector: FlowSelector
): Promise<DescribeFrame | "aborted" | undefined> {
  const resolved = await waitForFrameAndTree(env, selector);
  return typeof resolved === "object" ? resolved.node.frame : resolved;
}

/**
 * {@link waitForFrame}, keeping the node it resolved and the settled tree that
 * node came out of.
 *
 * `runType` needs both: the last tree read before the tap was dispatched is the
 * only record of what the tap could have hit (see {@link tapCandidates}), and
 * the node is the element the step went on to tap — which is not always what
 * the same selector resolves to a moment later (see {@link trackTarget}).
 *
 * "The last read", not "the screen at the instant of the tap": {@link
 * settleTree} returns the last read that SUCCEEDED on its best-effort timeout
 * path, so when the read after it runs to the platform's cap before failing,
 * the tree handed back predates the tap by `SETTLE_POLL_MS` plus that read's
 * duration — up to ~15s on Android, ~10s on Chromium, ~5s on iOS. A node that
 * had already moved out from under the tap point can therefore still sit in
 * `underTap` and confirm a clear the screen at dispatch time would not have.
 * That window opens on the whole best-effort path, not only on a read that
 * failed outright: `settleTree` also returns its last successful read when
 * every read SUCCEEDED and no two consecutive ones matched — a spinner, a live
 * clock, a blinking caret — and there the staleness is one poll rather than a
 * platform cap. A read failing outright is the wider case, and once NO read
 * succeeds it is the outage `settleTree` throws on instead. Either way
 * `settleTree` gives the caller no signal that its return was best-effort, so
 * nothing downstream can narrow it further today.
 */
async function waitForFrameAndTree(
  env: ActionEnv,
  selector: FlowSelector
): Promise<{ node: DescribeNode; tree: DescribeNode } | "aborted" | undefined> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  for (;;) {
    if (env.signal?.aborted) return "aborted";
    const tree = await settleTree(env);
    if (tree) {
      const node = flowSelectorToNode(tree, selector);
      if (node) return { node, tree };
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
 * Containment slack, in normalized screen fractions. Both frames being compared
 * come out of ONE tree read by ONE adapter, so there is no cross-adapter
 * disagreement to absorb — what there is, is a hair of overhang: a border, a
 * focus ring, sub-pixel rounding of an integer bounds pair. Matches
 * `ui-tree-match`'s `WITHIN_EPS` (which reads it the same way for `within:`
 * scopes) and this file's own `EDGE_EPS`.
 *
 * Per-EDGE slack, so it does not on its own say whether a node is bigger than
 * the one it is being compared to — see {@link frameNoLargerThan}.
 */
const FRAME_CONTAINMENT_EPSILON = 0.005;

/** Is `inner` inside `outer` (equal frames included)? */
function frameWithin(inner: DescribeFrame, outer: DescribeFrame): boolean {
  const e = FRAME_CONTAINMENT_EPSILON;
  return (
    inner.x >= outer.x - e &&
    inner.y >= outer.y - e &&
    inner.x + inner.width <= outer.x + outer.width + e &&
    inner.y + inner.height <= outer.y + outer.height + e
  );
}

/**
 * Is `inner` no bigger than `outer` along either axis?
 *
 * {@link frameWithin} alone cannot answer this: its slack is per-edge, so a
 * frame overhanging by the epsilon on EVERY side — the `encloses` shape the
 * same file refuses as "not evidence" — satisfies it while being a full
 * epsilon larger in each dimension. Measured: a focused `android.webkit.WebView`
 * enclosing its target by 4px on every side on a 1080x1920 screen passed
 * containment and took the clear.
 *
 * No epsilon of its own, for the reason {@link frameCoversTap} has none: any
 * slack here is slack a symmetric pad hides inside. A focus trap laid over the
 * field, larger by ONE pixel on every edge, is the same geometry as a child
 * overhanging its wrapper by a border's width — one tolerance cannot admit the
 * second and refuse the first, and the flow trees carry no ancestry to tell
 * them apart with (`flattenHoisting` returns leaves under one root on every
 * platform). Reproduced on Chrome 151 at a 1px pad: a `focusin` trap holding
 * `DRAFT-do-not-erase` over an `<input>` passed the step, and the draft was
 * emptied and rewritten while the named input kept its old value.
 *
 * So the size test is exact, and the cost is a `clear` refused when the focused
 * child is genuinely a hair wider than the box the selector named. That
 * direction is safe: the step fails and says so. Equal frames still pass, which
 * is the everyday wrapper-around-input shape.
 */
function frameNoLargerThan(inner: DescribeFrame, outer: DescribeFrame): boolean {
  return inner.width <= outer.width && inner.height <= outer.height;
}

/**
 * Does `frame` cover the point a tap was dispatched at — the way the OS hit
 * test covers it?
 *
 * Half-open, so the start edge belongs to the frame and the end edge belongs to
 * the next one along. That is what `Rect.contains`, `CGRectContainsPoint` and
 * Chrome's `elementFromPoint` all do, and asking the same question the OS
 * answered is the whole point: this decides which of a row's children the tap
 * that moved focus actually landed on.
 *
 * {@link frameContains} — inclusive on every edge — cannot: when a container's
 * two children split it evenly the container's centre IS the seam, so BOTH
 * halves contain it and the test discriminates nothing, while the tap went to
 * exactly one of them (the right/lower one). Reproduced on Chrome 42 and on
 * Android API 36: a 50/50 row whose LEFT input held focus took a clear aimed at
 * the row and reported a pass, where the same page split 30/70 refused. Even
 * splits are the common case, not a corner: an OTP row of 6 boxes on a 1080px
 * screen lands on exact 180px boundaries.
 *
 * No epsilon. The slack that {@link frameWithin} needs absorbs a border's
 * overhang between two frames; here a hair of slack on the end edge would put
 * the seam back. Frames that genuinely straddle the point by less than a device
 * pixel are left to the refusal, which is the safe direction.
 */
function frameCoversTap(frame: DescribeFrame, x: number, y: number): boolean {
  return x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height;
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
 * Does a focus-flagged node stand for `target` — the one case identity cannot
 * serve, where the selector names a testID container and the input inside it is
 * what the tree flags?
 *
 * The node has to sit inside the target's box, be no bigger than it, AND be one
 * of the elements the tap could have hit ({@link tapCandidates}). Containment
 * alone has no discriminator at all: a container that
 * holds more than one input is the everyday row (an `amount-row` over currency
 * and amount, an OTP row that forces focus to the first empty box wherever you
 * tap, a card number/expiry/cvc row with auto-advance), and a suggestion
 * popover or autocomplete list drawn over a composer is inside it too. Either
 * way the step clears whichever node reports focus and reports a pass on the
 * container — reproduced on Chrome 151 both ways round: the tap landed in
 * `#amount` while the keys emptied and rewrote `#currency`, and `#composer`
 * kept its draft while the overlay `#mention` took the replacement.
 *
 * "Could have hit" is settled ONCE, against the tree the tap was dispatched
 * from, and never recomputed from the target's current frame. Recomputing looks
 * safer — it follows a field that keyboard avoidance scrolls away — but it
 * silently follows a container that GROWS as well, and a combobox wrapper
 * rendering its listbox inside itself on focus is exactly that: the recomputed
 * centre drops out of the input and into the option list, and the clear is
 * refused with a reason naming an overlay or a sibling row, neither of which
 * exists. Downshift, HeadlessUI and most React Native autocompletes render the
 * list inside the wrapper, and the wrapper is where a testID sits. Reproduced
 * on Chrome 42, and a validation message appearing under the field crosses the
 * same threshold. Matching by {@link sameElement} instead of by geometry is
 * what keeps the moved-field case working without it.
 *
 * Structure would be the sharper test, but the flow trees do not carry it on
 * ANY platform: `flow-chromium-tree` runs the same `flattenHoisting` pass as
 * the Android and iOS full-hierarchy adapters, so a wrapper and the input it
 * wraps arrive as SIBLINGS and there is no ancestry to consult. Worth stating
 * plainly, because every reproduction cited above comes from Chrome — where the
 * agent-facing `describe` DOES print a nested tree, and a reader could
 * reasonably conclude the sharper test was available there.
 *
 * Deliberately NOT a role test on the target. Asking "is the target itself a
 * text input" both over- and under-matches against the roles the adapters
 * really emit: Material's `TextInputLayout` wrapper derives `TextField`, ARIA
 * 1.1 puts `combobox` on the wrapper around the input, a `contenteditable`
 * composer is role `div`, and React Native's iOS host views come through as
 * `AXStaticText`. The first two refused a legitimate wrapper clear, the last
 * two admitted the overlay the test exists to catch.
 *
 * An overlay covering the tap point confirms only if it was ALREADY under that
 * point when the tap was dispatched — `underTap`, read from the settled tree
 * the frame was resolved against. Geometry alone cannot separate "the tap hit
 * the overlay" from "the overlay appeared BECAUSE of the tap", and the second
 * is an everyday shape: an @-mention list, an inline emoji or date picker, a
 * formatting bar with its own input. Nothing hit those, so focus landing in one
 * is not the honest consequence of the gesture — reproduced on Chrome 42, where
 * a popover opened by the composer's own `focus` handler took the clear while
 * the composer kept its draft, and the step reported a pass on the composer.
 * The same page with the popover already open still confirms, and so does the
 * same page with no popover at all.
 */
function focusedFromInside(
  tree: DescribeNode,
  target: DescribeNode,
  focused: DescribeNode[],
  tap: TapCandidates
): boolean {
  return focused.some((n) => {
    if (!frameWithin(n.frame, target.frame) || !frameNoLargerThan(n.frame, target.frame)) {
      return false;
    }
    // {@link sameElement} compares NAMES, and a name stands for an identity only
    // while it picks out ONE element. Inside a container it routinely picks out
    // several — which is the very shape this gate exists to refuse, so accepting
    // "the focused node is A namesake of something under the tap" hands the
    // clear to whichever namesake happens to hold focus. Reproduced on Chrome
    // 151: an amount-row whose two anonymous inputs both read "Amount", tap on
    // the right one, focus forced to the left one, and the LEFT field was
    // emptied and rewritten with a pass reported on the row. The same page with
    // the second input named "Currency" refused. An OTP row does it too, and on
    // Android it needs no coincidence at all — `identifier` is the raw
    // resource-id, which names the layout slot, so every row inflated from one
    // layout carries the same one.
    //
    // So the name has to resolve, in the tree the tap was dispatched from, to
    // exactly one candidate — and THAT candidate is what must have been under
    // the tap. Ambiguity is not evidence, and refusing is the safe direction.
    const named = tap.inside.filter((before) => sameElement(before, n));
    if (named.length !== 1) return false;
    // And unambiguous in the tree the VERDICT is drawn from, not only in the
    // one the evidence was collected in. The two halves of this gate are joined
    // by a name across two different tree reads and two different container
    // boxes, so a focused node can otherwise borrow the evidence gathered for a
    // different element. Three ways in, all reproduced on Chrome 151 against
    // this branch:
    //   - a namesake the TAP CREATES. `tap.inside` is frozen before the tap, so
    //     an element that appears inside the container on focus is invisible to
    //     the check above — the wrapper-grows-on-focus shape (Downshift,
    //     HeadlessUI, a React Native autocomplete), and on Android every row
    //     inflated from one layout shares its resource-id. A wrapper that
    //     appended a second `row_input` and focused it passed, and the field the
    //     step never named was emptied and rewritten;
    //   - a container that GROWS. Candidates are frozen to the pre-tap box while
    //     containment is judged against the current one, so a 44px row growing
    //     to 140px on focus swallowed a field that was never a tap candidate at
    //     all, and cleared it;
    //   - a focused field that RENAMES ITSELF out of the namesake set — a
    //     currency input dropping its separators, a phone or card mask — leaving
    //     a sibling as the unique pre-tap match. That sibling was under the tap,
    //     so the row's own mis-target passed.
    // Each of the three leaves two namesakes inside the container in the current
    // tree, and each refuses once that is what decides. Removing the growth, the
    // late namesake or the rename refuses too, which is the pre-existing
    // behaviour these three were routing around.
    if (currentInside(tree, target).filter((now) => sameElement(now, n)).length !== 1) {
      return false;
    }
    if (tap.underTap.includes(named[0])) return true;
    // The tap point is ONE point — the container's centre — and a container is
    // not laid out to put its input there. When that point lands on inert
    // chrome (a `<label for>`, a helper line, the padding) nothing under it
    // could have taken the keys itself, so the app routing focus to the
    // container's one control is the honest consequence of the gesture rather
    // than a competing element winning it. Measured on Chrome 151: the same page
    // refused or cleared purely on whether the label was taller than the input
    // — 32px passed, 40px failed — while the tap focused the right field either
    // way, the same step without `clear` succeeded, and the refusal blamed an
    // overlay and a sibling row that did not exist. A two-line label, a label
    // with vertical padding, and a label plus helper text all sit past that
    // line, so it is a layout coin toss rather than a corner.
    //
    // A control under the point is the whole difference from the row this gate
    // refuses: there the tap DID reach something that takes focus, and focus
    // sitting on a different sibling is exactly the mis-target. The target
    // itself never counts — the everyday React Native shape is a `Pressable`
    // wrapping a `TextInput`, so the container is clickable by construction.
    //
    // ONE control, and the one that reports focus. "Nothing under the tap is a
    // control" is not on its own evidence that focus followed the gesture:
    // `underTap` holds only what COVERS the point, so any gap between two
    // children — a flex `gap`, `space-between`, a margin, a divider the adapter
    // does not emit — empties it and passes the test below vacuously, leaving
    // the clear to whichever sibling happened to hold focus already. Reproduced
    // on Chrome 151: a row of two inputs with a 30px gap, its centre falling
    // between them and the LEFT input focused before the step, passed and
    // rewrote that left input; an OTP row of six boxes with a 12px gap did the
    // same four boxes away from the tap point. Closing the gap so the boxes
    // touch sends the clear to the box under the tap, which is correct.
    //
    // Requiring the container's one control is also what `references/
    // flow-yaml.md` already promises, and it keeps the sibling refusals the doc
    // lists (a currency/amount row, one cell of an OTP row) refusing however the
    // row is spaced.
    //
    // Counting controls at all is only possible on a SCREEN where the source
    // reports them: the iOS full-hierarchy adapter never sets `clickable`
    // (`flow-ios-tree`), so there this arm never admits anything and the shape
    // it exists to fix still falls through to the refusal below.
    //
    // "And nothing else under the tap is a control" needs no separate test:
    // `underTap ⊆ inside`, so a clickable member of it other than `tapped`
    // would be in `controls` — which has exactly one member, and that member is
    // not under the tap or the arm above would have returned.
    const controls = tap.inside.filter((before) => before !== tap.tapped && before.clickable);
    return controls.length === 1 && controls[0] === named[0];
  });
}

/**
 * Do two nodes read from two DIFFERENT tree reads stand for the same element?
 *
 * Object identity cannot answer it — each read builds a fresh tree — and the
 * frame cannot either, because the whole reason to ask is that the element may
 * have moved (keyboard avoidance) or the box around it grown. What is left is
 * the element's name: its role plus its identifier, both of which an id/testID
 * pins across reads and neither of which focus changes.
 *
 * With no identifier on either side there is no stable name, so the label
 * settles it. That is weaker — a field that reformats its value on focus (a
 * currency input dropping its separators) changes its label and stops matching
 * itself — which is why the label is consulted only when the identifier is
 * absent on both sides, the case where the alternative is matching every
 * anonymous node of the same role against every other.
 */
function sameElement(a: DescribeNode, b: DescribeNode): boolean {
  if (a.role !== b.role || a.identifier !== b.identifier) return false;
  return a.identifier !== undefined || a.label === b.label;
}

/**
 * Is the focus flag on an element whose ENTIRE content is the target — the
 * editing host whose own text the selector named?
 *
 * Quill, ProseMirror and Lexical all render `<div contenteditable><p>…</p></div>`.
 * The editable node carries no id, no accessible name and no own text, so the
 * only text in the tree belongs to the block child, and every selector that can
 * name the editor's content resolves to something INSIDE the focused node.
 * That classifies as "encloses" and is refused with advice — *point the
 * selector at the input itself* — which cannot be followed, because there is
 * nothing else to point at. Reproduced on Chrome 42, where the identical page
 * with an id on the editable, or with the `<p>` replaced by a bare text node,
 * cleared fine.
 *
 * Equality is not on its own enough to keep this away from the shapes
 * "encloses" exists to refuse: a focus trap holding a `<textarea>` over the
 * field confirms the moment its draft happens to equal the field's value, and
 * that costs the draft. Reproduced on Chrome 151 — a `focusin` trap over an
 * `<input>` holding `old.remembered.login`, with the textarea holding the same
 * string, passed the step, emptied the TEXTAREA and rewrote it with the new
 * address while the named input kept its old one. The same page with any other
 * draft in the textarea refused. Worse, the coincidence is structural rather
 * than lucky: an anonymous target does not shield (`flow-tree-flatten`), so its
 * text hoists into every enclosing node's `subtreeText`.
 *
 * So the focused node must have NO text of its own ({@link nodeText} — its
 * label and value). That is what "this element's content IS the thing named"
 * means for an editing host: the editable carries no id, no accessible name and
 * no own text, and the only text on it is the target's, hoisted. A trapped
 * `<textarea>` fails it (an unlabelled one's value IS its accessible name). A
 * focused `android.webkit.WebView` carrying the whole form fails the content
 * count below rather than this guard — its fields are identified, so their text
 * never reaches its hoist in the first place.
 *
 * The flow adapters flatten to leaves under one root, so tree ancestry is not
 * available to ask this more directly; hoisted text ({@link assertText}) is
 * what survives the flatten.
 *
 * And the named content must not be a CONTROL. An editing host's content is
 * static — a paragraph, a text node — while a focused wrapper around one text
 * FIELD produces the identical tree: the field's value is its accessible name,
 * an anonymous field does not shield, so the value hoists and the wrapper has
 * no text of its own either. That is the shape the paragraph above says the
 * `!nodeText` guard refuses, and it does not: the `android.webkit.WebView`
 * argument only holds for a WebView carrying a WHOLE form, while one wrapping
 * exactly one field — hosted payment fields are one input per iframe — passed.
 * Confirmed on Chrome 151: a `<div tabindex=0>` focus-trapped around an
 * unidentified `<input value="hello-target">` CONFIRMED, and only the keyboard
 * tool's own "the focused element DIV#wrap is not a text field" stopped the
 * clear — a backstop iOS and Android do not have, since both dispatch a clear
 * at whatever holds focus. Where a source reports no controls at all (the iOS
 * full-hierarchy adapter never sets `clickable`), this cannot discriminate and
 * the residual stands.
 *
 * Text equality alone does not say the editor holds nothing else, because the
 * hoist it is read from is not a full account of the editor's content: an
 * identified descendant SHIELDS its own text out of every ancestor's
 * `subtreeText` (`flow-tree-flatten`), and a password field shields too. So an
 * editing host holding the named paragraph PLUS any amount of identified
 * content hoists only the paragraph and compares equal, while the clear —
 * select-all over the host — destroys all of it. Reproduced on Chrome 151: a
 * composer holding `<p>Draft body paragraph</p>` beside `<div id="signature">`
 * passed, wiped the editor to the replacement text and took the signature with
 * it; the identical page with the signature ANONYMOUS refused, because then its
 * text hoisted and the equality failed. `data-testid`, a `<input
 * type=password>` and three identified card fields all behaved like the id.
 *
 * What the shield hides from the hoist it does NOT hide from the tree — the
 * shielding node is emitted as its own leaf. So the content is counted from
 * the flat tree instead ({@link holdsUnnamedContent}), which is the same
 * question asked where the answer survives the flatten.
 *
 * Residuals: an editor holding more than the named paragraph shows more text
 * than the selector named, so it still refuses — with the same unfollowable
 * advice. Naming the whole body, or giving the editable an id, both work.
 */
function focusedOwnsTargetText(
  tree: DescribeNode,
  target: DescribeNode,
  focused: DescribeNode[]
): boolean {
  const named = assertText(target);
  if (!named || target.clickable) return false;
  return (
    focused.length > 0 &&
    focused.every(
      (n) =>
        n !== target &&
        frameWithin(target.frame, n.frame) &&
        !frameNoLargerThan(n.frame, target.frame) &&
        !nodeText(n) &&
        assertText(n) === named &&
        !holdsUnnamedContent(tree, n, target)
    )
  );
}

/**
 * Does `host` contain anything the selector did NOT name — content a clear on
 * `host` would destroy without the step ever mentioning it?
 *
 * Read from the flat tree rather than from `host`'s hoisted text, because the
 * hoist is exactly what a shield removes (see {@link focusedOwnsTargetText}).
 * "Content" is anything a leaf can stand for: its own text, an id/testID, a
 * control, or a password field — a masked field carries no text at all, and
 * losing it is the most expensive of the four.
 *
 * Nodes inside the TARGET's own box are what the selector named, so they never
 * count; every adapter flattens to leaves, so this is a frame test rather than
 * an ancestry one.
 */
function holdsUnnamedContent(
  tree: DescribeNode,
  host: DescribeNode,
  target: DescribeNode
): boolean {
  let found = false;
  const walk = (node: DescribeNode): void => {
    if (found) return;
    if (
      node !== host &&
      node !== target &&
      frameWithin(node.frame, host.frame) &&
      !frameWithin(node.frame, target.frame) &&
      (Boolean(nodeText(node)) ||
        node.identifier !== undefined ||
        node.clickable === true ||
        node.password === true)
    ) {
      found = true;
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return found;
}

/**
 * Find `tapped` again in a tree read after the tap.
 *
 * Re-running the selector is not the same question. It asks "what does this
 * selector match NOW", and the answer changes when the tap adds a better-ranked
 * match: a field that opens a typeahead list on focus, where a suggestion
 * repeats the field's own value, hands the match to the suggestion — the chip
 * is smaller than the input and `selectorToNode` ranks smallest-frame-wins. The
 * focus check would then test focus against an element the step never touched
 * and refuse the clear, saying focus never reached the target while focus is
 * exactly where the flow put it. Reproduced on Chrome 42; changing only the
 * suggestion's text made the same step pass.
 *
 * So follow the element instead ({@link sameElement}), and use the selector
 * only as the fallback for a round where it cannot be found — a re-render that
 * changes the label of a node carrying no identifier, say.
 *
 * When SEVERAL nodes answer to the name, none of them is "the element": the
 * name is not an identity, and picking one by proximity to where the tap landed
 * is a coin toss that a re-layout decides. Keyboard avoidance — the everyday
 * movement this function exists to follow — is exactly such a re-layout.
 * Reproduced on Chrome 151: two rows sharing a `data-testid`, the selector
 * resolving to the first, and a 100px scroll during the focus wait putting the
 * SECOND row where the first had been. It became the nearest namesake, the
 * identity arm in `waitForFocus` then trusted it absolutely, and the field the
 * selector never resolved to was emptied and overwritten with the step
 * reporting a pass. The same page with distinct testids refused.
 *
 * So an ambiguous name yields no target at all — not even the selector's own
 * pick, which ranks by frame and reading order and would hand back one of the
 * same namesakes on the strength of a tie-break. With no target node there is
 * nothing to confirm against, which for a `clear` is a refusal and for a plain
 * `type` is the best-effort path it was already on.
 *
 * The fallback has to stay ON the tap point for the same reason. Unlike the
 * identity arm it carries no relation to the element the step touched — it is
 * whatever the selector matches NOW — while `waitForFocus`'s identity arm
 * trusts what comes back absolutely, ahead of the two arms that check a node
 * against {@link tapCandidates}. When the tapped element stops being findable
 * (it unmounted as a consequence of the tap: a tap-to-edit row, a conditional
 * render, a virtualized list) and a DIFFERENT element answering the same
 * selector holds focus, that element was confirmed and cleared. Reproduced on
 * Chrome 151 — `aria-label="Email"` removed on `mousedown`, `aria-label="Email
 * address"` focused beside it, and the second field's draft was emptied and
 * rewritten with a pass reported; the same page with the row left mounted
 * refused. A re-render in place — the case the fallback exists for — still
 * covers the point the tap was dispatched at, so it is unaffected.
 */
function trackTarget(
  tree: DescribeNode,
  tapped: DescribeNode,
  selector: FlowSelector,
  tap: { x: number; y: number }
): DescribeNode | undefined {
  const named: DescribeNode[] = [];
  const walk = (node: DescribeNode): void => {
    if (sameElement(tapped, node)) named.push(node);
    for (const child of node.children) walk(child);
  };
  walk(tree);
  if (named.length > 1) return undefined;
  if (named[0]) return named[0];
  const bySelector = flowSelectorToNode(tree, selector);
  return bySelector && frameCoversTap(bySelector.frame, tap.x, tap.y) ? bySelector : undefined;
}

/**
 * What a focusing tap on `tappedFrame` could have reached, read ONCE from the
 * settled tree that frame was resolved from. {@link focusedFromInside} matches
 * a focus-flagged node against these, which is how an overlay drawn in RESPONSE
 * to the tap is told apart from one the tap landed on.
 */
interface TapCandidates {
  /** The node the tap was dispatched at, as it stood in that same tree. */
  tapped: DescribeNode;
  /**
   * Everything that sat inside the tapped node's box before the tap. The scope
   * the focused node's NAME has to be unambiguous in: two of these answering to
   * one name is exactly the row `focusedFromInside` refuses.
   */
  inside: DescribeNode[];
  /** Those of {@link inside} the tap point itself landed on. A subset, by identity. */
  underTap: DescribeNode[];
  /** Where the tap was dispatched — the centre of {@link tapped}'s frame. */
  point: { x: number; y: number };
}

/**
 * What sits inside `target`'s box in the tree a verdict is being drawn from —
 * the current-tree counterpart of {@link TapCandidates.inside}, and read by the
 * same rule so the two sides of {@link focusedFromInside}'s name join are
 * symmetric.
 */
function currentInside(tree: DescribeNode, target: DescribeNode): DescribeNode[] {
  const inside: DescribeNode[] = [];
  const walk = (node: DescribeNode): void => {
    if (frameWithin(node.frame, target.frame) && isVisible(node)) inside.push(node);
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return inside;
}

function tapCandidates(preTap: DescribeNode, tapped: DescribeNode): TapCandidates {
  const tap = getDescribeTapPoint(tapped.frame);
  const inside: DescribeNode[] = [];
  const underTap: DescribeNode[] = [];
  const walk = (node: DescribeNode): void => {
    if (frameWithin(node.frame, tapped.frame) && isVisible(node)) {
      inside.push(node);
      if (frameCoversTap(node.frame, tap.x, tap.y)) underTap.push(node);
    }
    for (const child of node.children) walk(child);
  };
  walk(preTap);
  return { tapped, inside, underTap, point: tap };
}

/**
 * Outcome of the focus handshake. The distinctions only matter to a destructive
 * `clear`; plain typing treats everything but a hard abort as best-effort.
 *
 * - "confirmed" — the target itself reports focus, or a node belonging to it
 *   does ({@link focusedFromInside}). The keys will land in the field the step
 *   named.
 * - "encloses" — the only focus-flagged node overlapping the target CONTAINS
 *   it. That is not evidence: it is what a hybrid app's focused WebView and an
 *   ordinary focus trap look like, and each can coexist with a different
 *   element genuinely holding the keys.
 * - "overlaps" — a focus-flagged node overlaps the target without being it and
 *   without containing it: an overlay over the field (a suggestion popover, an
 *   autocomplete list), or a partial overlap. Also not evidence — clearing on
 *   it empties the overlay.
 * - "unconfirmed" — the tree reported focus, on something that does not
 *   overlap the target at all.
 * - "unobservable" — no focus evidence anywhere. Today that always means every
 *   read succeeded and no node was flagged. The {@link FOCUS_REPORTING_SOURCES}
 *   guard also returns it, but no flow can reach that: `type` runs only on ios,
 *   android and chromium (`runDirective` refuses it on Vega), and each of those
 *   hard-codes one source that is already in the set — `native-devtools`
 *   (`flow-ios-tree`), `android-devtools` (`flow-android-tree`), `cdp-dom`
 *   (`describe/platforms/chromium`). It is kept as a forward guard: a new
 *   platform would otherwise poll the full timeout on every type step.
 * - "unreadable" — every read in the window threw, so nothing at all was
 *   observed. Distinct from "unobservable", where reads DID succeed: this is
 *   the tree-source outage `settleTree` refuses to swallow for the same reason.
 *
 * Membership in {@link FOCUS_REPORTING_SOURCES} is not enough to tell these
 * apart. An iOS device whose injected framework predates the `firstResponder`
 * field answers `getFullHierarchy` without it (see `flow-ios-tree`), so the
 * source is native-devtools yet no node is ever flagged — verified on an
 * iPhone 16 Pro, where treating that as "unconfirmed" refused every clear on
 * the platform. Hence the outcome keys off what the tree reported, not off the
 * source alone.
 */
type FocusOutcome =
  | "confirmed"
  | "encloses"
  | "overlaps"
  | "unconfirmed"
  | "unobservable"
  | "unreadable";

/**
 * Poll until the typed-into element, or something belonging to it, reports
 * `focused`.
 *
 * Identity first, then {@link focusedFromInside}: the selector often matches a
 * testID container while focus is reported by the input inside it, and the two
 * are then different nodes with different frames. The target NODE is found
 * again each round by {@link trackTarget} — the keyboard sliding up routinely
 * scrolls the field away from where it was tapped (keyboard avoidance), and the
 * focused element must be compared against where the field is NOW — but by
 * following the element the step tapped, not by re-running the selector, which
 * a post-tap suggestion list can answer with something else entirely.
 *
 * Neither arm accepts a bare overlap. A focus-flagged node large enough to
 * COVER the target satisfies an overlap test by construction, and every shape
 * that produces one can hide a different element holding the keys:
 *
 *   - a CLOSED shadow root, where `el.shadowRoot` is null so the walker cannot
 *     descend and cannot read the root's own activeElement: the HOST is
 *     flagged, the element with the caret never reaches the tree at all. (An
 *     OPEN root no longer produces this — since the describe walker reads the
 *     activeElement of an element's own ROOT, the inner element is what carries
 *     the flag and the host is excluded. Before that, a clear aimed at an
 *     `<input>` overlaid on a screen-spanning host emptied the SHADOW field and
 *     reported a pass, 3/3 on a Chromium page.);
 *   - an ordinary focus trap — a `focusin` handler bouncing focus back to a
 *     `<textarea>` — which leaves a focused text field whose box contains the
 *     target. The same run cleared the trapped field and left the named one
 *     untouched;
 *   - a hybrid app's focused `android.webkit.WebView` wrapping the form.
 *
 * The cost is a `clear` refused when the selector names a LABEL inside the
 * focused field. That direction is safe: the step fails, says so, and points at
 * the selector. The overlap reading's cost was destroying a field the step
 * never named while reporting a pass.
 *
 * Reports rather than decides: plain typing types on any outcome (misplaced
 * text is visible and additive), while `runType` refuses to dispatch a
 * destructive clear on anything but "confirmed" and "unobservable".
 *
 * `requireEvidence` says which of those two callers is asking. Only a `clear`
 * reads the verdict, so only a `clear` has to keep polling once a read has
 * settled the question of whether SOMETHING holds the target: a plain `type`
 * ends its wait the moment any focus-flagged node overlaps, and pays one poll
 * instead of the whole {@link TYPE_FOCUS_TIMEOUT_MS} for an answer it discards.
 * A form of n fields typed into without a `clear` would otherwise pay n × 3s
 * for verdicts nobody reads, whenever the tree flags something that covers the
 * field rather than the field itself.
 *
 * The exit fires on the two verdicts that mean focus HAS landed somewhere over
 * the target, and deliberately not on a tree that flags focus nowhere: there is
 * nothing focused yet to type into, and the rest of the wait is the app's focus
 * round-trip. So the iOS build without `firstResponder` documented above — the
 * one shape where no read ever flags anything — still pays the whole
 * {@link TYPE_FOCUS_TIMEOUT_MS} and its reads on every plain `type`, for a
 * verdict `runType` discards. Known, and the safe side of the trade.
 *
 * Current Android is NOT that tree, so the saving is smaller than it looks
 * there: surveyed across eight screens on API 36 / WebView 151, including a
 * genuine in-app `android.webkit.WebView`, the WebView is `focused="false"`
 * every time and the inner `EditText` carries the flag — every screen had
 * exactly one focused node and no focused ancestor. Older WebView builds were
 * not testable here, and the exit costs nothing on a tree that confirms, so it
 * stays.
 */
async function waitForFocus(
  env: ActionEnv,
  into: FlowSelector,
  tapped: DescribeNode,
  preTapTree: DescribeNode,
  requireEvidence: boolean
): Promise<FocusOutcome> {
  const deadline = Date.now() + TYPE_FOCUS_TIMEOUT_MS;
  const tappedFrame = tapped.frame;
  const candidates = tapCandidates(preTapTree, tapped);
  // Did the MOST RECENT successful read see focus on anything? Deliberately the
  // latest look and not "any look, ever": the question the caller is about to
  // act on is whether something else holds focus NOW, and a sticky flag answers
  // it with history instead. It also made the verdict a race — an app that
  // blurs on the focusing tap reports focus for however many rounds precede the
  // blur, so the same flow against the same app failed or passed depending on
  // whether round 1 beat the blur. `undefined` until a read succeeds, so a
  // window in which every read throws stays distinguishable — see `giveUp`,
  // which maps it to "unreadable" and NOT to "unobservable".
  let lastRead: "focus-elsewhere" | "focus-encloses" | "focus-overlaps" | "no-focus" | undefined;
  // The most recent read that actually SAW focus on something. An empty
  // `focused[]` is not the observation "nothing is focused": it is equally "this
  // read could not see the element that is", which both flow adapters produce
  // for a frame that clips to zero area — the everyday keyboard-avoidance
  // scroll, and on Android a healthy `uiautomator` dump whose focused view's
  // bounds have collapsed. Letting it overwrite a determinate sighting turns a
  // refusal into a destructive clear on the very field the run had already
  // identified as holding the keys: reproduced on Chrome 151, where collapsing
  // the focused input's box mid-window (it keeps the caret throughout and is
  // still `document.activeElement` at the end) took the step from "focus never
  // reached the target" to a pass that emptied and rewrote it.
  //
  // Latest-read-wins still decides between the sightings themselves, which is
  // what keeps a blur-on-tap from being answered with history.
  let lastSighting: "focus-elsewhere" | "focus-encloses" | "focus-overlaps" | undefined;
  // Reads that have thrown since the last successful one. `lastRead` is only
  // ever written by a read that SUCCEEDED, so without this one successful poll
  // disarms the outage verdict permanently — including the very first, which is
  // the one most likely to report "no-focus" because the app's focus round-trip
  // has not finished. That mapped to "unobservable", which a destructive clear
  // goes through on, so an outage in the TAIL of the window converted a correct
  // refusal into a blind clear. Reproduced on Chrome 151 by poisoning the tree
  // read at t+600ms, where focus landed elsewhere at t+900: the step passed and
  // emptied a field it never named, while the same page with the reads left
  // alone refused.
  let darkTail = 0;
  // When the current run of unanswered reads STARTED — the instant the window
  // last knew anything. Undefined whenever the most recent read succeeded.
  let darkSince: number | undefined;
  // What a healthy read costs on THIS device, from the most recent one that
  // answered. 0 until one does. Read by the affordability check in the loop.
  let lastReadMs = 0;
  const giveUp = (): FocusOutcome => {
    // `undefined` means no read ever succeeded — an outage, not an observation.
    // Reporting it as "unobservable" would let a clear through on the strength
    // of a window in which nothing was seen at all; `settleTree` sets the same
    // convention for the same condition, and for the same reason.
    if (lastRead === undefined) return "unreadable";
    // The window went dark, so a verdict narrated from the reads before the
    // darkness would describe a screen nobody saw at the deadline — the rule
    // `CONDITION_DARK_TAIL_TOLERANCE_MS` states for `waitForCondition`. Either
    // measure of darkness settles it: consecutive failed polls, or one span of
    // the window long enough that a verdict from before it is stale (see
    // FOCUS_DARK_TAIL_POLLS for why a hang can only ever be caught by the
    // second).
    if (darkTail >= FOCUS_DARK_TAIL_POLLS) return "unreadable";
    if (darkSince !== undefined && Date.now() - darkSince >= FOCUS_DARK_TAIL_TOLERANCE_MS) {
      return "unreadable";
    }
    const seen = lastRead === "no-focus" ? lastSighting : lastRead;
    if (seen === "focus-encloses") return "encloses";
    if (seen === "focus-overlaps") return "overlaps";
    return seen === "focus-elsewhere" ? "unconfirmed" : "unobservable";
  };
  for (;;) {
    if (env.signal?.aborted) return giveUp();
    // Before the read, not after it. The sleep below is capped to land exactly
    // ON the deadline, so a check that ran afterwards let one more whole tree
    // read start past it — and a read costs an android-devtools `getHierarchy`
    // or a CDP DOM walk, a real fraction of the 3000ms every refusal message
    // claims the observation window was.
    if (Date.now() >= deadline) return giveUp();
    const readStartedAt = Date.now();
    // A read the window cannot afford is not started at all. Its budget is
    // whatever is left of the window, so one started too late is abandoned
    // mid-flight — and `giveUp` books that abandonment as darkness, which is a
    // fact about read latency against the deadline phase and not about the
    // device. The step then failed telling the author "the device's tree source
    // is down" while every read in the window had answered. Worse, whether the
    // last read starts far enough before the deadline to cross
    // FOCUS_DARK_TAIL_TOLERANCE_MS depends on how the read time divides into
    // TYPE_FOCUS_TIMEOUT_MS, so the verdict was not monotonic in latency:
    // measured on Chrome 151, a page whose focus the tree cannot report failed
    // as an outage at ~900ms and ~1200ms per read while passing at 0ms — same
    // page, same screen, every read successful in all of them. Android's
    // `getHierarchy` sits squarely in that band (2.85s / 0.29s / 0.46s / 0.30s
    // across four consecutive idle `describe` calls on this host), so the same
    // step flips between pass and hard failure with load alone.
    //
    // A source that has never answered is exempt: `lastReadMs` is 0, the read
    // starts, and a hang consumes the whole window and IS reported as an
    // outage — which is the case the dark tail exists for.
    if (lastReadMs > 0 && deadline - readStartedAt < lastReadMs) return giveUp();
    // Bounded by what is left of the window, the way `waitForIdle` bounds its
    // own read. No AbortSignal reaches any transport, so an unbounded read
    // overran the window by its transport timeout instead — up to 15s on
    // Android — and every refusal message still narrated the wait as 3000ms.
    // The abandoned read's eventual settle is consumed by `settleWithin`.
    const read = await settleWithin(readFlowTree(env), deadline - readStartedAt, env.signal);
    if (read.type === "aborted") return giveUp();
    if (read.type !== "value") {
      // A read that threw, or one still in flight when the window ended —
      // either way this poll observed nothing. `lastRead` is left alone so a
      // window of nothing but failures stays "unreadable", and the darkness is
      // dated from when the read STARTED, since that is when the window stopped
      // learning anything.
      darkTail++;
      darkSince ??= readStartedAt;
    } else {
      const { tree, source } = read.value;
      darkTail = 0;
      darkSince = undefined;
      lastReadMs = Date.now() - readStartedAt;
      if (!FOCUS_REPORTING_SOURCES.has(source)) return "unobservable";
      // The target NODE, not just its frame: identity is the only unambiguous
      // evidence. `tappedFrame` still covers a round where neither the element
      // nor the selector resolves, but only the refusal classification below
      // can use it — with no node there is nothing to confirm against.
      const targetNode = trackTarget(tree, tapped, into, candidates.point);
      const target = targetNode?.frame ?? tappedFrame;
      const focused = collectFocused(tree, []);
      // Classified from the MOST RECENT successful read, never from "any read,
      // ever": the question the caller is about to act on is what holds focus
      // NOW, and a sticky flag answers it with history. It also made the
      // verdict a race — an app that blurs on the focusing tap reports focus
      // for however many rounds precede the blur.
      if (focused.some((n) => n === targetNode)) return "confirmed";
      if (targetNode && focusedFromInside(tree, targetNode, focused, candidates)) {
        return "confirmed";
      }
      if (targetNode && focusedOwnsTargetText(tree, targetNode, focused)) return "confirmed";
      lastRead =
        focused.length === 0
          ? "no-focus"
          : // Genuinely larger, not merely containing: `frameWithin`'s slack is
            // per-edge, so two identical frames satisfy it, and a focused node
            // whose frame EQUALS the target's is not the WebView-or-focus-trap
            // shape "encloses" describes — telling its author to point the
            // selector at the input itself is advice they have already taken.
            // Reachable whenever `trackTarget` cannot identify the element and
            // `target` falls back to the frame the tap was dispatched at.
            focused.some((n) => frameWithin(target, n.frame) && !frameNoLargerThan(n.frame, target))
            ? "focus-encloses"
            : focused.some((n) => framesOverlap(n.frame, target))
              ? "focus-overlaps"
              : "focus-elsewhere";
      if (lastRead !== "no-focus") lastSighting = lastRead;
      // Enough for a caller that will not act on the verdict: something focused
      // covers the target, which is as far as a plain `type` ever needed to get.
      // The refusal arms below are the same verdicts, just reached now instead
      // of at the deadline.
      if (!requireEvidence && (lastRead === "focus-encloses" || lastRead === "focus-overlaps")) {
        return giveUp();
      }
    }
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) return giveUp();
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
export function offscreenHint(sel: FlowSelector): string {
  return `no visible element matched selector ${describeSelector(sel)} — if it is off-screen, add a scroll-to step before this one`;
}

/**
 * Execute one directive step: the selector-acting ones (`tap` / `long-press` /
 * `type` / `await` / `assert` / `scroll-to` / `pinch` / `rotate`) plus `idle`,
 * which takes no selector because stillness is a property of the whole screen.
 */
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
 * What a selector-less gesture's settle leaves behind: the abort signal its
 * caller turns into a skip, and the warning it owes the step report.
 */
type GestureSettle = { aborted?: true; warning?: string };

/**
 * Settle the screen for a gesture that resolves no selector — raw coordinates,
 * or a centre-anchored `pinch`/`rotate`. A selector target gets its settle from
 * `waitForFrame`; without one there was nothing to resolve, so the gesture went
 * out against whatever motion was in flight and a coordinate tap could land
 * mid-fling — the very race the settle exists to close.
 *
 * Best-effort where the selector path is not: no frame is being read out of the
 * tree here, so a source outage must not fail this gesture, which would break
 * the escape hatch coordinates exist to be (an element the tree cannot see).
 * The same allowance `snapshot` makes before a capture that reads pixels rather
 * than nodes.
 *
 * It is also the caller `skipProvenOutage` exists for, because a tree the run
 * can never read is not only the disconnect mid-run: an app that cannot load
 * the instrumentation fails every read off an in-memory list — an Apple system
 * app, which flows drive by coordinates for exactly that reason, so every step
 * of such a flow arrives here. Charging each of them a window for the same
 * verdict is what the memo takes off them.
 *
 * A platform with no tree source at all is the one case that settles nothing
 * and reports nothing. `ios-remote` is coordinate-driven by necessity —
 * `fetchFlowTree` serves it no tree, so every selector directive already fails
 * there and a coordinate flow is the only kind such a run can have. There is no
 * source to be down, so there is no degradation to warn about: buying the
 * window and warning would put ~400 characters of "restore the tree source" on
 * every gesture of every green run there, and neither remedy it names exists.
 *
 * Swallowing the outage is not the same as hiding it: the returned `warning`
 * rides the step report, so a gesture dispatched into whatever motion was in
 * flight is distinguishable from one that waited. Every gesture the memo spares
 * carries it, not just the one that proved the outage - a run told once about a
 * source that was dead for all of it would understate what its greens bought.
 * Only the outage path warns; a window that expired without converging did
 * settle, for as long as a settle can be given.
 *
 * The other cost is a screen that never holds still - a spinner, a video, a
 * ticking clock. Nothing converges, so every selector-less gesture pays the
 * whole window (measured at ~3.05s per gesture), and the memo buys no relief:
 * a window that read the tree proves no outage, deliberately. The fingerprint
 * cannot be narrowed the way `scrollToVisible` narrows its own either. That
 * one knows which motion it is waiting on - its own scroll, inside the scroll
 * containers under its anchor - so it can name the nodes worth watching. A
 * gesture is waiting on motion of unknown origin (a transition, a fling, a
 * keyboard) that can move what sits under the point without touching it, so
 * there is no narrower scope that is still correct. It is the same window every
 * selector directive already pays on such a screen; what changed is that
 * coordinate targets now pay it too.
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
      // Should one ever serve past that, the message it attributes to the device
      // would be wrong on a path that goes green, where a selector step would
      // error on the same tree.
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
 * Coordinate targets are the fallback for elements with no stable selector
 * (e.g. an unlabeled view).
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
 * `clickCount`: one resolution, one dispatched multi-tap gesture — never N
 * separate calls, whose RPC gaps could fall outside the OS double-tap window.
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
 * flow-pinch-geometry). Open-loop by design: there is no "current zoom"
 * to read back, so flows assert on the result, not the multiplier.
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
  return { ok: true, ...warned(settle) };
}

/**
 * Best-effort screen aspect (width / height) for the rotate directive's
 * physical-circle geometry. One dedicated tree read instead of threading
 * dimensions through settleTree/waitForFrame: the settle loop already reads
 * the tree several times per step, so the extra fetch is noise, and the
 * resolution path every other directive shares stays untouched.
 *
 * The one read {@link ActionEnv.treeOutage} must not spare, unlike the whole
 * settle {@link settleForGesture} skips: this answer is DISPATCHED, not waited
 * on. A stale verdict would degrade a centre rotate on a phone from the
 * edge-safe vertical placement the real aspect picks (Down points at
 * y = 0.278 / 0.722) to the aspect-1 fallback, which puts both fingers 0.48 off
 * centre on whichever axis wins: on iOS the two candidates tie and horizontal
 * takes it (x = 0.02 / 0.98, inside the 0.08 side guard), while Android's wider
 * side guards pick vertical (y = 0.02 / 0.98, inside the top/bottom one).
 * Either way both fingers start in a guard.
 *
 * A true verdict costs one failed read instead, which the caller degrades past
 * exactly as it degrades past a skip - but not for free: this read carries no
 * budget and no signal, so on iOS it is the 15s hierarchy tier. Less than the
 * whole settle the memo saved - window and floor reads alike, two reads on that
 * same tier when the source fails by timing out - but still the price of never
 * dispatching geometry off a prediction, and what every rotate paid before the
 * memo existed.
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
 * Rotate by `by` degrees (+ clockwise) about a selector's frame centre
 * (settled tree + auto-wait, like tap) or the screen centre. Both branches
 * settle first; the centre one through {@link settleForGesture}, which is
 * best-effort and adds an abort checkpoint. One continuous gesture — fingers
 * orbit the fixed centroid at a constant physical radius, so any angle
 * dispatches without decomposition or settle delays, and the angular delta is
 * exact with zero pan/pinch coupling. The initial finger axis is the safer of
 * horizontal and vertical (see flow-rotate-geometry);
 * duration derives from the angle at the fixed ~90°/300ms pace — `by` is
 * bounded at parse. NOT the `rotate` tool — that changes device orientation.
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

  // Guards are resolved exactly once per directive; geometry only ever
  // receives them as data (the seam for a future per-device query).
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
  // The tool rejects when cancelled mid-gesture; per ABORTED_OUTCOME that must
  // read as an aborted skip, never a step failure with the tool's message.
  const rotated = await dispatchOrAbort(env, "gesture-rotate", {
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
  if (!rotated) return ABORTED_OUTCOME;
  return { ok: true, ...warned(settle) };
}

/**
 * Why a `clear` was refused, phrased per outcome so the advice matches the
 * observation. Every arm keeps the substring "refusing to clear", which is what
 * a caller (and the suite) greps for.
 *
 * Deliberately names no element text: the reason is echoed to the agent and
 * printed by `argent flow run`, and a focused node's label can BE the field's
 * value. (Nothing writes the step report to a file — `--output` exports failed
 * snapshot images only — but stdout and the agent's context are surfaces
 * enough.)
 */
function clearRefusalReason(into: FlowSelector, focus: FocusOutcome): string {
  const sel = describeSelector(into);
  const head = `refusing to clear ${sel}`;
  if (focus === "encloses") {
    return (
      `${head}: the only element reporting focus within ${TYPE_FOCUS_TIMEOUT_MS}ms CONTAINS ${sel} ` +
      `rather than being it — a focused WebView or a focus trap looks exactly like this while a ` +
      `different element holds the keys, so clearing here can empty that element instead. A field ` +
      `that merely OVERHANGS the box ${sel} names reads the same way, which default content-box ` +
      `sizing does for a few pixels. Point the selector at the input itself, or clear it with the ` +
      `app's own affordance`
    );
  }
  if (focus === "overlaps") {
    return (
      `${head}: within ${TYPE_FOCUS_TIMEOUT_MS}ms focus was reported on an element that OVERLAPS ` +
      `${sel} without being it and without covering where the tap landed — an overlay over the ` +
      `field (a suggestion popover, an autocomplete list), a SIBLING inside the container ` +
      `${sel} names (a currency/amount row, an OTP row), or the field itself overhanging that ` +
      `container's box, which default content-box sizing does for a few pixels. Clearing would ` +
      `empty that element instead. Dismiss the overlay first, or name the input that actually ` +
      `holds the caret`
    );
  }
  if (focus === "unreadable") {
    return (
      `${head}: the UI tree stopped answering before the ${TYPE_FOCUS_TIMEOUT_MS}ms focus wait ` +
      `ended, so nothing is known about what holds focus NOW. Retry the step; if it persists the ` +
      `device's tree source is down`
    );
  }
  return (
    `focus never reached ${sel} within ${TYPE_FOCUS_TIMEOUT_MS}ms — ` +
    "refusing to clear, since the keys would empty whatever else holds focus. Check that the " +
    "selector resolves to the input itself rather than to its label or a wrapper around it — " +
    "an id/testID selector is the reliable way to say so when the field's only stable name sits " +
    "on a neighbouring element"
  );
}

/**
 * Resolve `into` → tap to focus → wait for focus to land → clear and/or type
 * text in one keyboard call → optionally press Enter in a second.
 *
 * `submit` presses a trailing Enter to commit the value and dismiss the
 * keyboard, so it can't obscure later steps (chained form fields that end in an
 * explicit submit `tap` should pass `submit: false`). It defaults to true when
 * there is text, and to false for a clear-only step — Enter into a field the
 * step just emptied is never the intent.
 */
async function runType(
  env: ActionEnv,
  step: { into: FlowSelector; text?: string; clear?: boolean; submit?: boolean }
): Promise<DirectiveOutcome> {
  const resolved = await waitForFrameAndTree(env, step.into);
  if (resolved === "aborted") return ABORTED_OUTCOME;
  if (!resolved) {
    return { ok: false, reason: offscreenHint(step.into) };
  }
  const { node: tappedNode, tree: preTapTree } = resolved;
  // Wrapped like the two keyboard dispatches below, so all three of this step's
  // device calls classify a cancelled run the same way. Leaving the focus tap
  // bare made one step report `error` or `skip` depending on which dispatch
  // happened to be in flight when the caller gave up. What makes this step the
  // one that needed wrapping is that it makes SEVERAL dispatches with no guard of
  // its own between them; every other directive is already covered from
  // somewhere:
  //
  //   - `runTap` and `runLongPress` leave their dispatch bare, and can: one call
  //     each, so there is no within-step split to classify inconsistently.
  //   - `scrollIncrement` is bare too, but a `scroll-to` step calls it up to
  //     MAX_SCROLL_ITERATIONS times — `scrollToVisible` guards the signal at the
  //     head of every iteration, so a cancel is caught before the next increment
  //     rather than after the wrong one.
  //   - `runPinch` chains several, and guards the signal between them itself.
  if (!(await dispatchOrAbort(env, "gesture-tap", getDescribeTapPoint(tappedNode.frame)))) {
    return ABORTED_OUTCOME;
  }
  // Keys are injected at the HID level and go to whatever holds focus, so the
  // tap→type gap must cover the app's focus round-trip (see the constants).
  if (!(await sleepOrAbort(TYPE_FOCUS_SETTLE_MS, env.signal))) {
    return ABORTED_OUTCOME;
  }
  const focus = await waitForFocus(env, step.into, tappedNode, preTapTree, step.clear === true);
  // waitForFocus returns on abort as well as on focus/timeout — re-check before
  // every keyboard dispatch (the keyboard tool has no abort handling of its
  // own), so a cancelled run can never type into, or submit, whatever the app
  // has focused after the caller gave up.
  if (env.signal?.aborted) return ABORTED_OUTCOME;
  // Typing without confirmed focus is best-effort — keys land in whatever holds
  // focus, and misplaced text is additive and visible. A clear is neither, so it
  // only runs on evidence, or on the absence of any:
  //
  //   - "unconfirmed": the tree reported focus and never on the target, so the
  //     tap did not move focus. Clearing then wipes the field the run was
  //     previously in (unrecoverable, reported as a pass on a field it never
  //     touched) or lands nowhere while the report still claims a clear. Both
  //     reproduced on a Pixel 3a against a real app.
  //   - "encloses" / "overlaps": the focus flag covers the target, or sits over
  //     it without being it. Neither is evidence — see waitForFocus for the
  //     shapes that produce them and the field each destroyed instead of the
  //     named one.
  //   - "unreadable": every read in the window threw, so nothing was observed.
  //     A tree-source outage is not the same as a tree that reported nothing,
  //     and only the second is safe to clear on.
  //
  // "unobservable" — reads succeeded and flagged nothing anywhere — DOES fall
  // through to the same best-effort path as typing, which is what keeps `clear`
  // working on an iOS build whose injected framework omits `firstResponder`.
  //
  // Known residual, and the reason `argent-create-flow` says to assert the
  // result: "unobservable" also covers states where something IS focused and
  // the tree cannot say so. It no longer covers them once a read in the same
  // window has SEEN where focus is (see `lastSighting`), so what is left is a
  // window in which no read ever saw it:
  //
  //   - an app that BLURS on an outside tap before the first read;
  //   - a focused field with no on-screen frame. All THREE flow adapters drop
  //     the leaf for a frame clipping to zero area, so the flag goes with it —
  //     an off-screen field is the persistent case (positioned there by design,
  //     not moved there by a scroll), a keyboard-avoidance scroll the transient
  //     one. The shared scroll-clip prune (`flow-tree-flatten`) drops one whose
  //     own frame is a healthy on-screen rect, which "clipping to zero area"
  //     does not describe: a non-clipping carousel, a nested scroller;
  //   - a focused field the adapter prunes as INVISIBLE before focus is
  //     considered. `flow-ios-tree` drops `hidden === true || alpha < 0.01`,
  //     and `flow-android-tree` drops the `com.android.systemui` package and
  //     its resource-id prefixes — which is the notification direct-reply field
  //     and the bouncer. Chromium no longer belongs here: its walker keeps the
  //     branch holding the caret (see `holdsFocus` in describe/platforms/
  //     chromium), which is what the opacity:0 OTP-capture shape needs;
  //   - a TRUNCATED tree, on either source. `blueprints/android-devtools`
  //     returns `truncated` and `windowCount` and `flow-android-tree`
  //     destructures only `{ xml }`; on Chromium the node-cap sets a `hint`
  //     that `flow-chromium-tree` drops. A partial tree with no focus flag is
  //     indistinguishable from "nothing is focused". (The repo's own
  //     `keyboard/platforms/android` treats those same two fields as
  //     disqualifying.) iOS truncates by depth instead — `maxDepth: 40` — with
  //     no signal at all;
  //   - focus inside a Chromium sub-document. The describe walker's iframe
  //     descent is dead: `el instanceof Element` rejects the inner
  //     `documentElement`, because that constructor belongs to the OUTER realm.
  //     Pre-existing and not fixed here — reviving the descent also needs every
  //     inner frame translated into the host document's coordinates, or the
  //     tree gains nodes whose boxes point at the wrong place.
  //
  // Deliberate — the alternative refuses every clear on the iOS builds above
  // (verified: it did). It is NOT justified by "a clear with nothing focused
  // loses no data": that premise is false for every shape above, and each of
  // them is a field the step never named. The justification is only that
  // refusing here costs the platform its `clear` outright, while clearing the
  // WRONG field is worse than either — so `argent-create-flow` telling authors
  // to assert the result is load-bearing, not advisory.
  if (step.clear && focus !== "confirmed" && focus !== "unobservable") {
    return { ok: false, reason: clearRefusalReason(step.into, focus) };
  }
  // Clear and text ride ONE keyboard call. Each backend validates the WHOLE
  // request before touching the device precisely so a rejected call leaves no
  // trace — `assertTypeableAndroidText`, and the per-character resolves in the
  // chromium and simulator-server backends, all run ahead of the clear. Issuing
  // them separately steps outside that guarantee: the clear commits, the text is
  // then rejected, and the field is left EMPTY by a call that returned 400. On a
  // Pixel 3a, `{ into: field, text: "José", clear: true }` destroyed the field's
  // value as two calls, where the same arguments as one call left it intact.
  //
  // No read-back check follows the clear. Re-reading the focused node and
  // failing if it still holds text cannot be made to work against the flow
  // trees: on iOS a field's contents never reach them at all (`flow-ios-tree`
  // projects {role, frame, children, label, identifier, focused}), and where the
  // check CAN see something it misfires — an emptied Android field with a
  // contentDescription reports its HINT, and a Chromium field carrying an
  // aria-label / aria-labelledby / placeholder reports that LABEL, since
  // `accessibleName` returns it long before it reaches `el.value`. What each
  // platform does expose is tabulated once in the `argent-create-flow` skill, in
  // `references/asserting-field-values.md`, beside the assert guidance that
  // depends on it. The focus refusal above — plus the keyboard tool rejecting
  // `clear` outright on backends that cannot perform it — is where that risk is
  // actually handled.
  if (step.clear || step.text !== undefined) {
    const sent = await dispatchOrAbort(env, "keyboard", {
      ...(step.clear ? { clear: true } : {}),
      ...(step.text !== undefined ? { text: step.text } : {}),
    });
    if (!sent) return ABORTED_OUTCOME;
  }
  // Outside the submit gate, not inside it. `dispatchOrAbort` reclassifies only
  // a dispatch that REJECTS while the signal is aborted, and the Android keyboard
  // backend takes no signal at all — so a cancel landing mid-call leaves the call
  // to resolve and returns `true`. The backends that DO take one (iOS, Chromium)
  // only narrow the window rather than close it: each checks between keystrokes,
  // so an abort arriving after the last check still lets the call finish. Inside
  // the gate this check ran only for a step that submits, which made a cancelled
  // clear-only step (where `submit` defaults to false) report a pass while the
  // identical cancellation on a submitting step reported a skip.
  if (env.signal?.aborted) return ABORTED_OUTCOME;
  // Default: submit when there is text to commit, not on a clear-only step.
  if (step.submit ?? step.text !== undefined) {
    // Enter is the ONE part that stays a separate call, and it has no choice:
    // the keyboard tool rejects a combined `{ text, key }` outright (see
    // ../keyboard/index.ts), so two calls are the only way to express "type,
    // then submit". That is why the clear/text pair above does NOT split the
    // same way — `clear` combines with `text` freely, and folding it in is what
    // keeps it atomic with the text it replaces.
    //
    // On an Android TV target this call is where a step with NO `clear` fails:
    // the text lands and the submit errors, because `typeTv` rejects `key`
    // unconditionally. A `clear: true` step never reaches any dispatch at all —
    // a tap cannot move D-pad focus, `android-devtools` is in
    // FOCUS_REPORTING_SOURCES so the wait really looks, and it reports
    // "unconfirmed", which the refusal above turns into a failed step. The
    // `typeTv` clear rejection is therefore unreachable from a flow `type` step;
    // it is what a direct `keyboard` call hits. (Android TV is the TV kind that
    // reaches here at all: `runDirective` gates `type` on Vega alone, and an
    // Apple TV stops at the focus tap above, whose `gesture-tap` resolves
    // simulator-server and rejects a tvOS UDID.)
    if (!(await dispatchOrAbort(env, "keyboard", { key: "enter" }))) {
      return ABORTED_OUTCOME;
    }
  }
  // The same re-check as before the submit gate, for the same reason, because the
  // Enter is a second dispatch and inherits the whole problem: `dispatchOrAbort`
  // reclassifies only a dispatch that REJECTS under an aborted signal, and the
  // Android backend takes no signal at all, so a cancel landing mid-Enter leaves
  // the call to resolve and hands back `true`. With nothing between that and the
  // pass below, the same cancellation window flipped a step between `pass` and
  // `skip` on which of its two keyboard calls happened to be in flight — and the
  // `pass` arm is the one where the submit really was sent after the caller gave
  // up, which is exactly what the check above says must not happen.
  if (env.signal?.aborted) return ABORTED_OUTCOME;
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

// ── Screen readiness ─────────────────────────────────────────────────
//
// `await: { idle: true }` asks one question a selector condition cannot: has
// the screen stopped moving? It is deliberately NOT an identity check — a
// dropped tap leaves the source screen perfectly idle — so it belongs next to
// the element check that says WHICH screen, never instead of it.
//
// It never fails a run. Readiness is not an acceptance criterion: the flow's
// verdict belongs to the identity and outcome checks around it, and a screen
// that keeps moving is usually a property of the app rather than a regression
// — a video, a shimmer, a carousel. On Android it is also routine: that tree
// carries live text, so a ticking timer or a relative timestamp moves it on
// every read, where the iOS tree cannot see either. Hard-failing on a signal
// that sensitive, and that different per platform, turns one flow file into
// two verdicts. So a screen that never settles is reported as a WARNING on a
// passing step, naming what to look at.

/**
 * The cadence, the interval count and the defaults all live in flow-utils
 * beside the parser, which needs every one of them to reject a wait that could
 * never contain the settle it asks for. Aliased here for readability.
 */
const MIN_STILL_INTERVALS = IDLE_MIN_STILL_INTERVALS;

/**
 * How much budget must be left for another round to be worth STARTING — which
 * is checked before the poll sleep, so it is spent on the sleep and the round
 * that follows begins with whatever is left. It is a floor on the wait, not on
 * the round: what it rules out is starting a round in the last few
 * milliseconds of the step, where the capture is skipped and the read is
 * abandoned, and both absences used to be recorded as facts about the device —
 * "captures do not work here", "the tree source is not answering" — when the
 * step had simply run out of time.
 *
 * The first round always runs, so an unusually short `timeout:` still buys one
 * honest look, and ending up to one round early is strictly better than
 * judging a screen nobody managed to observe.
 */
const MIN_ROUND_BUDGET_MS = IDLE_POLL_MS;

/**
 * The screen settled, but something small on it moved while it did. A spinner
 * is the case that matters: it is far too small to move the screen (a stock one
 * measured 50-66 changed pixels of a phone capture — see
 * LOCALIZED_MOTION_MIN_PIXELS) and it does not move the tree either, since it
 * spins in a layer without its box ever changing — so both halves of the check
 * agree the screen is at rest while it is still loading. This is the only place
 * that difference is visible, so it is said outright.
 *
 * The claim is deliberately about the settle being reported and not about the
 * whole step: the flag is set by ANY interval of the winning hold and cleared
 * with the hold, so what it promises is that something small moved inside the
 * stretch of stillness this step is passing on — not that it moved from the
 * first read to the last.
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
 * screen genuinely takes seconds, and Android's `uiautomator dump` allows
 * itself twenty — so this is not a bound on the read. It is the size of the
 * gap that separates the two reasons a read fails to come back: the last read
 * of a step routinely times out with a couple of hundred milliseconds to its
 * name, and that is the step ending. One abandoned with seconds of budget in
 * hand is a source that has wedged, and no verdict about the app may be drawn
 * from a window nobody could see through.
 *
 * The budget alone cannot make that split, because every read here is
 * abandoned at the deadline: how much it had is a fact about the step's
 * arithmetic, not about the source. What separates them is what the source has
 * already shown it can do — so this is also the margin an abandoned read must
 * beat the SLOWEST read that came back by. A source answering in 2.5s has
 * proved a 2.1s read means nothing; one answering in 100ms has proved a 6.9s
 * read is a wedge.
 *
 * Without that second term a static screen on a slow source hard-stopped the
 * run: at 2500ms reads a 7500ms wait errored while a 6000ms one passed, and at
 * the 5400ms Android reads this step is sized against, 6 of 10 ordinary
 * timeouts errored on a screen that answered every read it was given time to
 * finish.
 */
const HUNG_TREE_READ_MS = 2_000;

/**
 * Evidence-gap bound for the post-loop verdict, and the idle twin of
 * {@link CONDITION_DARK_TAIL_TOLERANCE_MS}: how much of the end of the wait the
 * tree source may have spent failing before "the source stopped answering" is
 * the better account of the window than whatever the screen was doing.
 *
 * A tree-source blip is expected mid-settle — the loop restarts the hold and
 * carries on — and the read that happens to END the step is no more meaningful
 * than any other. Without this bound, one failed read on the last poll turned
 * every benign outcome into a run-stopping error, while the identical
 * transient one poll earlier passed with a warning: whether a flow survived a
 * screen this step is explicit about wanting to pass came down to where the
 * blip landed.
 *
 * Counted in ROUNDS rather than in milliseconds, unlike its `waitForCondition`
 * twin, because a round here is not a poll: it is `Promise.all([read,
 * capture])`, so it lasts `max(read, capture)`, and neither half is held to a
 * poll — `capturePixelsWithin` grants a capture seconds of its own
 * (PIXEL_CAPTURE_TIMEOUT_MS) and the read gets what is left of the step. A
 * wall-clock tolerance sized at two polls therefore expired whenever a round
 * merely ran long, which a capture backend that is slow but working is enough
 * to do — putting the verdict back on where the blip landed, the very thing
 * this bound exists to take it off.
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
 * Scoring one as an observation draws a verdict about the author's screen from
 * a window that was never readable.
 */
function isBlindTreeRead(data: DescribeTreeData): boolean {
  return data.tree.children.length === 0 && Boolean(data.hint || data.should_restart);
}

/**
 * Wait until the screen has content and stops moving — in the UI tree AND in
 * the rendered pixels.
 *
 * Both signals are required because each is blind to what the other sees. The
 * tree cannot see presentation-layer motion: an iOS push or modal dismissal
 * commits its hierarchy up front and then animates a layer over ~300-500ms, and
 * a cross-fade or a scrim moves no node at all — so a tree-only settle reports
 * a screen that is still sliding. Pixels cannot see a tree that is still
 * churning behind an unchanged-looking surface, and anything genuinely animated
 * forever (a video, a shimmer) would make a pixel-only settle unsatisfiable on
 * a screen the tree calls ready.
 *
 * This is `await-screen-idle`'s question asked against the tree the directives
 * actually resolve against. It returns early the moment the screen is still,
 * which is the point: the following tap resolves its target against a screen
 * that has stopped, instead of racing a transition still in flight.
 *
 * A screen that never settles spends the whole timeout and then passes with a
 * warning (see the section note above). Only an unreadable window is a hard
 * stop, and it is `indeterminate` — the check could not run, which is not a
 * verdict about the app.
 *
 * Every verdict is drawn from the LAST round that observed something, never
 * from a latch remembering that the screen was once still: a screen that
 * settles and then moves again has not settled.
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
  // How long the hold running at the last observed interval had lasted. Kept
  // so the report at the bottom can say what the wait reached rather than
  // asserting it reached nothing — a settle needs an interval COUNT as well as
  // a duration, and the count is the term a short wait usually misses.
  let heldForMs = 0;
  // Small, persistent motion seen across the intervals that produced the
  // current hold. Cleared with the hold, so it only ever describes the settle
  // actually being reported.
  let localizedMotionDuringHold = false;

  let readsSucceeded = 0;
  // Reads that came back with a tree AND something in it. Only these can
  // measure an interval, so this — not readsSucceeded — is what the
  // "too few reads to judge" guard at the bottom counts. A blank read is an
  // observation (it resets both holds) but never evidence about motion.
  let contentReads = 0;
  // Definitely assigned: the loop below always completes at least one round,
  // and every arm of that round sets it.
  let lastRead!: TreeReadOutcome;
  let treeErrorMessage: string | undefined;
  // Whether the last read that CAME BACK was a degraded one, and the repair it
  // named if it named one. Both are cleared by a read that carried a tree and
  // survive an abandoned one, exactly as treeErrorMessage does — so a degraded
  // tail is not thrown away by a closing round that merely ran out of budget.
  // `should_restart` arrives without a hint, so the flag cannot be inferred
  // from the message.
  let treeReadBlind = false;
  let blindHint: string | undefined;
  // Rounds since the last read that ANSWERED. Post-loop this is the dark tail:
  // how much of the window's final stretch went without a look at the screen.
  // A blank read clears it — it is an observation; see the blank branch.
  let darkReads = 0;
  let treeReadHung = false;
  // The slowest read that came back at all. A source cannot be called wedged
  // over a read cut off in less time than it has already been seen to need.
  let slowestAnsweredReadMs = 0;
  let sawContent = false;
  let pixelsEverMoved = false;
  // Whether two captures were ever put side by side. NOT "a capture failed":
  // the warning below is about a screen no pair could be read from, and one
  // dropped frame in a run of twenty says nothing about that.
  let comparedAPair = false;
  let firstCapture = true;

  for (;;) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    // The tree read is bounded by what is left of the step's budget, the same
    // way the capture is. Without that bound `timeout:` was not an upper bound
    // at all: no describe path takes a signal, and a wedged one (a hung
    // ViewInspector RPC, an `adb` that has stopped answering) ran the round
    // past the deadline — measured at 2.25s over an 8000ms budget.
    const roundBudget = Math.max(1, deadline - Date.now());
    const roundStartedAt = Date.now();
    // How long this round's read took to come back, timed on the read itself
    // rather than on the round. A round is the SLOWER of its two halves, and
    // what the hung-source check compares is how long this source takes to
    // answer — not how long the capture running beside it took.
    let answeredReadMs: number | undefined;
    // Read both signals from as close to one instant as possible: they describe
    // the same screen, and any gap between them is a window motion hides in.
    // They also travel over different channels (tree source vs. capture
    // backend), so serializing them would double the round without buying
    // anything.
    const [read, frame] = await Promise.all([
      settleWithin(readFlowTree(env), roundBudget, env.signal).then((r) => {
        answeredReadMs = Date.now() - roundStartedAt;
        return r;
      }),
      capturePixelsWithin(env, deadline, firstCapture),
    ]);
    firstCapture = false;
    // Before anything is concluded from this round: a capture abandoned by an
    // abort comes back indistinguishable from one that failed, and a verdict
    // about the app must never be derived from a run that was cancelled.
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
      // time — and the difference decides whether the bottom may describe the
      // app at all. A read cut off before it beat the source's own slowest
      // answer proves nothing about it.
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
      // hold state is left exactly as it was.
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
        // observation, so it also clears the tree-only verdict: a screen
        // showing nothing has not settled on anything.
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
        // observation — and, per MIN_STILL_INTERVALS, none comes from one
        // interval either. `stableFor: 0` therefore still means three reads:
        // a single sample proves nothing about motion, and a single agreeing
        // pair can be two points of an animation that reversed between them.
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

        // A missing frame is the ABSENCE of visual evidence — never evidence of
        // stillness, which is what turned a screen that never stopped moving
        // into a pass, and never evidence of motion either.
        //
        // Hence three states rather than two: `true` a compared pair held,
        // `false` a compared pair moved, `undefined` no pair to compare. Only
        // the middle one may break the hold. Reading the absence as `false`
        // made a dropped frame DESTROY the hold rather than merely fail to
        // extend it, which is the opposite of what this loop decides about an
        // abandoned tree read a few lines up — and it meant a backend that
        // drops the odd frame could serve no hold longer than the gap between
        // drops.
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
          // Only a frame that arrived replaces the reference. A missed capture
          // used to overwrite it with `undefined`, which cost the NEXT round its
          // comparison too — one slow capture blinded two intervals, so a
          // backend that is merely intermittently slow ended up reported as one
          // that could not be screenshotted at all. Holding the last good frame
          // asks the same question across the gap, over a longer interval.
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
        // measured no interval and refutes none, so the hold state is left
        // exactly as it was. It cannot settle the screen on its own — an
        // interval is only ever counted from a compared pair — so a run whose
        // captures all go missing still ends at the bottom, never in a pass.
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
    // (relaunch the app) is the wrong repair for the commonest cause of it
    // here: the app is simply not in the foreground, which reads exactly the
    // same from the tree source. Name that first so the author checks it
    // before relaunching anything.
    reason:
      `could not read the UI tree while waiting for the screen to settle — check the app is ` +
      `still in the foreground (a backgrounded app reads the same as an uninstrumented one). ` +
      `Underlying error: ${underlying}`,
  });

  // The other flavour: the source answered, and said it could not see the app.
  // Its own repair is the right one here — an unattached toolkit or a dropped
  // AX service is exactly what this shape means — so it is quoted rather than
  // replaced.
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
  // that went dark afterwards. (A read that merely ran out of budget is NOT
  // this case — it is the step ending, and the evidence below still stands.)
  //
  // Measured as a tail, not as a single read: the source failing on the last
  // poll and the source having stopped answering are different windows, and
  // only the second is unreadable. See IDLE_TOLERATED_DARK_READS.
  //
  // The tail is what decides, NOT how its last round happened to end. A round
  // that runs out of budget mid-read ends as a `timeout` however dead the
  // source is — the loop lets a round start on 200ms of budget, so any read
  // slower than that is abandoned — and requiring `error` here discarded the
  // whole accumulated tail with it: the dark rounds, the message, and the note
  // that names it. `treeErrorMessage` survives an abandoned read and is cleared
  // by a successful one, so it means exactly "the last read that came back did
  // so as a failure", which is the tail this describes.
  if (treeErrorMessage !== undefined && darkReads > IDLE_TOLERATED_DARK_READS) {
    return unreadable(treeErrorMessage);
  }
  // A degraded tail is the same window, reached the other way: the reads kept
  // arriving and kept saying nothing about the app. One is a blip like any
  // other and rides out on the same tolerance.
  if (treeReadBlind && darkReads > IDLE_TOLERATED_DARK_READS) {
    return degraded();
  }
  // The same window going dark the other way: the source answered, then stopped
  // answering with seconds of budget still in hand. A failing read has a
  // dedicated error above, but a HANGING one used to fall through to the
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
  // waitForCondition appends its own. (The tree-only settle is the one verdict
  // below that cannot be reached with a failed final read — that read cleared
  // `treeSettledAtLastRead` — so it is left alone rather than given a note it
  // could never print.)
  const blipNote =
    treeErrorMessage !== undefined
      ? ` (the last read that came back failed: ${treeErrorMessage})`
      : "";

  // Readable throughout and never once carrying content: the screen rendered
  // nothing, which is not the same claim as "it never stopped moving".
  //
  // A warning, not a stop. The tree read back fine — this is an observation
  // about the app, and readiness is never this step's to fail a run over. It
  // also is not always the app's fault: a screen legitimately renders no
  // accessible content (a bare canvas, a video surface, a splash image), and
  // stopping the flow there took every later step with it, including the
  // element check that would have said what was actually wrong.
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
  // Too few reads to have judged anything. A settle needs three of them
  // spanning two intervals, so a step that got fewer has no evidence either
  // way — and both verdicts below would be claims about an app that was never
  // observed for long enough to make one. The parser rejects a `timeout:` too
  // short to fit a settle, so what reaches here is a source slow enough to eat
  // the wait, or a window blank for most of it, either of which is worth
  // saying rather than dressing up as motion.
  //
  // Counted in reads that CARRIED CONTENT, not in reads that answered: a blank
  // one resets both holds and measures no interval. Counting it let a window
  // that was blank for all but its last two reads sail past this guard and
  // assert instead that "the screen never held still ... something on it never
  // stops" — a claim about motion drawn from a single measured interval.
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
  // The tree was settled as of the last read and no pair of captures ever
  // showed motion, yet the combined hold never completed. Once a pair has been
  // compared this is unreachable: a pair either agrees — and the tree was
  // holding, so the hold would have run — or disagrees, which sets
  // pixelsEverMoved. So a run that never got a pair is what is left, and it is
  // required here rather than assumed.
  //
  // Required as "never got a PAIR", not as "a capture failed once": the
  // sentence below is about a screen that could not be screenshotted often
  // enough to compare two of them, and a latch set by any single drop said that
  // to authors whose captures had arrived on three polls in four and whose
  // every compared pair read still.
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
  // count and a duration, so naming only the duration reported a screen that
  // had demonstrably held still as one that never did — and with `stableFor: 0`
  // it read as "never held still for 0ms", which nothing can fail. Name the
  // term that was actually short, and give the advice that repairs it: the wait
  // ran out, which is not the same as the screen never stopping.
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
