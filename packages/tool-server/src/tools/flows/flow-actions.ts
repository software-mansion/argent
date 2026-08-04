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
import { FlowTreeSettleTimeoutError, FlowTreeSourceUnavailableError } from "./flow-errors";
import { fetchFlowTree } from "./flow-tree";
import {
  capturePixels,
  getPixelCaptureSupport,
  pixelCaptureTimeoutMs,
  PIXEL_CAPTURE_TIMEOUT_MS,
  PIXEL_SETTLE_POLL_MS,
  PIXEL_SETTLE_TIMEOUT_MS,
  pixelsDiffer,
  type PixelCaptureSupport,
  type PixelSettleOutcome,
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
  { kind: "tap" | "long-press" | "type" | "await" | "assert" | "scroll-to" | "pinch" | "rotate" }
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

// One action-scoped deadline and retry cadence for every step kind — exported
// so flow-visual's snapshot settle retries on the same budget.
export const DEFAULT_ACTION_TIMEOUT_MS = 7500;
export const POLL_INTERVAL_MS = 300;

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
// fades. So once the tree converges, confirm the pixels stopped too. Captures
// and their observation gap share flow-pixels' bounded window; a perpetual
// animator is cut off earlier still, at the ordinary phase window below. A
// `scroll-to` uses this only before its first increment; later checkpoints
// are tree-only because each increment is already momentum-free/settled.
// Leave one bounded tree-read window after the pixel phase. Without this
// reserve a hung capture can consume the caller's entire deadline, leaving no
// opportunity to prove that the pre-capture selector coordinates are current.
const FINAL_TREE_REVALIDATE_RESERVE_MS = SETTLE_POLL_MS;
// The ordinary phase bounds ALL polling — tree re-reads and pixel-pair
// polling alike — and stays short enough for action-level callers to retry a
// stale final tree. The separate hard ceiling below covers only work already
// in flight when that window closes: a first capture may spend its full
// first-frame-aware budget, plus the one warm capture that completes its
// pair. The distinction is what keeps a screen with perpetual tree-invisible
// motion (video, a shimmer, a colour pulse) from converting one settle into
// the caller's whole action budget: polling stops at the phase window even
// though a slow cold capture may legitimately still be running past it.
const COMBINED_PHASE_TIMEOUT_MS = SETTLE_TIMEOUT_MS + PIXEL_CAPTURE_TIMEOUT_MS;
export const COMBINED_HARD_TIMEOUT_MS =
  SETTLE_TIMEOUT_MS + PIXEL_SETTLE_TIMEOUT_MS + FINAL_TREE_REVALIDATE_RESERVE_MS;
// A tree read already in flight may outlive the tree polling window: Android's
// full hierarchy commonly takes longer than 3s under load (the sources
// themselves budget far more — android-devtools grants getHierarchy 15s, and a
// uiautomator dump allows up to 20s). When no caller supplies a hard deadline,
// an unowned settle must not abandon that read sooner than the action budget
// every deadline-owning caller grants it (`Date.now() +
// DEFAULT_ACTION_TIMEOUT_MS`): anything shorter makes a healthy 5–7.5s read
// fail only the deadline-less call sites (`scroll-to`'s per-iteration settles)
// while every other directive would accept the same read. Matching the action
// budget keeps the timeout cliff at the same 7.5s everywhere.
const DEFAULT_TREE_READ_TIMEOUT_MS = DEFAULT_ACTION_TIMEOUT_MS;

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
   * best-effort result can outlive the last successful read when a capture,
   * an awaited capability probe, or a final tree read consumes a combined
   * settle's deadline — or, in either mode, when a mid-phase tree read
   * outlives the source read budget; acting callers must reject it.
   */
  treeFresh: boolean;
  /**
   * Pixel phase outcome. `skipped` means no pixel phase ran: tree-only mode,
   * a platform with no capture backend at all ({@link getPixelCaptureSupport} — the
   * only way a combined settle converges with `skipped`), or tree settling
   * exhausting its deadline before a combined settle could start (or re-run)
   * captures. `settled` always describes the screen as returned (a pre-restart
   * match is downgraded to `skipped`), so a caller may trust it without
   * `treeFresh` for anything that consumes no tree-derived value.
   * Aborts return `undefined` from settleTree instead of a result.
   */
  visual: Exclude<PixelSettleOutcome, "aborted"> | "skipped";
}

export type SettleMode = "combined" | "tree-only";

export interface SettleOptions {
  /** Combined tree + pixel stabilization by default; tree-only skips captures. */
  mode?: SettleMode;
  /**
   * Optional hard caller deadline. Phase windows still bound tree polling and
   * pixel comparison, but an already-started tree read may use this full
   * budget.
   */
  absoluteDeadline?: number;
}

type PixelCaptureResult =
  | Awaited<ReturnType<typeof capturePixels>>
  | "deadline"
  | "not-attempted"
  | "aborted";
type PixelCaptureSupportResult = PixelCaptureSupport | "deadline" | "not-attempted" | "aborted";
type TreeReadResult =
  | { type: "tree"; tree: DescribeNode }
  | { type: "error"; error: Error }
  | { type: "deadline" }
  | { type: "aborted" };

function noSuccessfulTreeRead(lastError?: Error): Error {
  // Only a completed source failure proves an outage. A read that merely
  // outlived our hard deadline may still succeed, so keep that as an ordinary
  // settle timeout instead of routing snapshots into their pixels-only outage
  // fallback.
  return lastError
    ? new FlowTreeSourceUnavailableError(lastError)
    : new FlowTreeSettleTimeoutError();
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
 * Bound a screenshot read by the settle deadline. The capture itself is never
 * cancelled — Chromium/CDP takes no signal, and the simulator-server arm
 * deliberately threads none (see `captureFile`: aborting the fetch would
 * orphan the temp PNG the server writes before replying) — so only our wait
 * is raced. The underlying {@link capturePixels} promise remains responsible
 * for decoding and deleting its temporary file when it eventually completes;
 * settleWithin also consumes a late rejection.
 *
 * The two zero-progress shapes stay distinct, mirroring
 * {@link pixelCaptureSupportBefore}: `not-attempted` means the pixel budget
 * was already spent before a capture could launch — no backend was consulted
 * and no time passed. `deadline` means a real capture was awaited and outlived
 * the wait — only there did unrevalidated time elapse while the screen may
 * have moved.
 */
async function capturePixelsBefore(
  env: ActionEnv,
  overallDeadline: number,
  timeoutMs: number
): Promise<PixelCaptureResult> {
  if (env.signal?.aborted) return "aborted";
  const deadline = Math.min(overallDeadline, Date.now() + timeoutMs);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return "not-attempted";
  const result = await settleWithin(capturePixels(env), remaining, env.signal);
  if (result.type === "aborted" || env.signal?.aborted) return "aborted";
  if (result.type === "timeout") return "deadline";
  // capturePixels is deliberately soft-failing, but keep that contract even if
  // a future implementation lets an error escape.
  if (result.type === "error") return undefined;
  return result.value;
}

/**
 * Bound the native runtime-kind capability probe by the caller's hard budget.
 *
 * The two zero-progress shapes stay distinct. `not-attempted` means the budget
 * was already spent before the probe could start: no time passes here, so
 * whatever the caller's tree looked like an instant ago it still looks like
 * now. `deadline` means the probe was genuinely awaited and outlived the wait
 * — only there did unrevalidated time elapse while the screen may have moved.
 */
async function pixelCaptureSupportBefore(
  env: ActionEnv,
  deadline: number
): Promise<PixelCaptureSupportResult> {
  if (env.signal?.aborted) return "aborted";
  const remaining = deadline - Date.now();
  if (remaining <= 0) return "not-attempted";
  const result = await settleWithin(getPixelCaptureSupport(env.device), remaining, env.signal);
  if (result.type === "aborted" || env.signal?.aborted) return "aborted";
  if (result.type === "timeout") return "deadline";
  // The support resolver normally converts lookup failures to `unknown`; keep
  // that honest fallback if its implementation ever lets an error escape.
  if (result.type === "error") return "unknown";
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
 * and never attempts a pixel capture; a platform with no capture backend at
 * all ({@link getPixelCaptureSupport}) settles the same way even in combined mode.
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
 * Throws in exactly two shapes, both raised only when the window closes with
 * zero successful reads — with any successful tree in hand, deadline
 * exhaustion returns best-effort results instead, the contract consumers are
 * written against (`resolveTargetPoint` catches only
 * {@link FlowTreeSettleTimeoutError}, `settleSnapshot` only the two typed
 * errors). {@link FlowTreeSourceUnavailableError}: some read completed with a
 * failure — a proven tree-source outage (e.g. native devtools disconnected
 * mid-run — `fetchFlowTree` refuses to degrade to a trimmed tree), not a
 * mid-animation blip, and swallowing it would convert the outage into a
 * misleading "element not found" downstream.
 * {@link FlowTreeSettleTimeoutError}: no read completed at all — explicitly
 * not proof of an outage, since an in-flight native hierarchy read may still
 * succeed after we stop waiting. Either throw lands in the step's structured
 * report via `execLeafStep`'s catch.
 */
export async function settleTree(
  env: ActionEnv,
  options: SettleOptions = {}
): Promise<SettleResult | undefined> {
  const mode = options.mode ?? "combined";
  const settleTimeout = mode === "combined" ? COMBINED_PHASE_TIMEOUT_MS : SETTLE_TIMEOUT_MS;
  const startedAt = Date.now();
  // Tree/pixel polling retains its per-settle budget so a caller can retry a
  // stale result while its wider action window remains.
  const phaseDeadline = Math.min(
    options.absoluteDeadline ?? Number.POSITIVE_INFINITY,
    startedAt + settleTimeout
  );
  const hardDeadline =
    options.absoluteDeadline ??
    startedAt + (mode === "combined" ? COMBINED_HARD_TIMEOUT_MS : SETTLE_TIMEOUT_MS);
  // The source operation has a distinct hard boundary. Do not silently shorten
  // a caller-owned action budget to the internal 5s combined window, or a
  // healthy 5–7.5s native hierarchy read becomes an early action failure. With
  // no caller deadline, grant the read the same action budget an owning caller
  // would pass, so the unowned settle stays bounded without a lower cliff of
  // its own.
  const treeReadDeadline = options.absoluteDeadline ?? startedAt + DEFAULT_TREE_READ_TIMEOUT_MS;
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
    const treeDeadline = Math.min(phaseDeadline, Date.now() + SETTLE_TIMEOUT_MS);
    let prevFp = seedFp;
    let stableTree: DescribeNode | undefined;
    let stableFp: string | undefined;
    let attemptedTreeRead = false;

    // Tree phase: find two matching successful reads. A failed read stays a
    // transient gap, preserving the previous successful fingerprint exactly as
    // the original tree-only settle did.
    for (;;) {
      if (env.signal?.aborted) return undefined;
      // Always permit the phase's first read, even when the caller handed us a
      // deadline equal to "now", so its no-read result retains the established
      // timeout taxonomy. After an attempt, however, never start another poll
      // once the phase deadline has elapsed (including a sleep landing on it).
      if (attemptedTreeRead && Date.now() >= treeDeadline) {
        if (lastTree === undefined) throw noSuccessfulTreeRead(lastError);
        return { tree: lastTree, converged: false, treeFresh, visual };
      }
      attemptedTreeRead = true;
      // The tree-phase deadline bounds polling for a matching pair, not the
      // source operation itself. Let an in-flight read use its remaining hard
      // budget: a healthy 3.5s Android hierarchy read must not be abandoned at
      // the 3s settle window when a longer read budget is still available.
      const reading = await fetchTreeBefore(env, treeReadDeadline);
      if (reading.type === "aborted") return undefined;
      if (reading.type === "deadline") {
        if (lastTree === undefined) {
          throw noSuccessfulTreeRead(lastError);
        }
        // A read was genuinely awaited here and outlived the source read
        // budget: unrevalidated time — up to that whole budget — passed since
        // the carried tree was read, morally the same hung wait as a capture
        // or capability probe consuming the deadline, so the tree must come
        // back unsafe for acting callers (`scroll-to` skips the round and
        // re-settles instead of dispatching off a screen no second read ever
        // confirmed). The zero-time shape cannot smuggle a fresh tree through
        // this return: every phase window is capped by the read budget, so a
        // non-first poll only launches with budget open, and a phase's first
        // read starting past it can hold no successful read — it throws
        // above.
        return { tree: lastTree, converged: false, treeFresh: false, visual };
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
        if (lastTree === undefined) throw noSuccessfulTreeRead(lastError);
        return { tree: lastTree, converged: false, treeFresh, visual };
      }
      const sleepMs = Math.min(SETTLE_POLL_MS, Math.max(0, treeDeadline - Date.now()));
      if (!(await sleepOrAbort(sleepMs, env.signal))) return undefined;
    }

    // A platform with no capture backend converges tree-only by construction:
    // `visual` stays "skipped" — an architectural absence, not the
    // probed-and-failed "unavailable" — and no revalidation read is owed
    // because no pixel wait ran for the tree to move under.
    if (mode === "tree-only" || pixelsUnavailable) {
      return { tree: stableTree, converged: !pixelsTimedOut, treeFresh: true, visual };
    }
    // The instant the pair converged, taken before the awaited support probe.
    // On iOS a cold probe is a real `xcrun simctl` round trip, so the
    // `not-attempted` capture arm below cannot assume this instant is "now" —
    // it compares against this timestamp to tell a spent-before-convergence
    // pixel window from one the probe itself consumed.
    const pairConvergedAt = Date.now();
    const pixelSupport = await pixelCaptureSupportBefore(env, hardDeadline);
    if (pixelSupport === "aborted" || env.signal?.aborted) return undefined;
    if (pixelSupport === "not-attempted") {
      // What spent the budget was the healthy tree read just above, not a sick
      // probe: an in-flight read is deliberately allowed to run to the caller's
      // action deadline (see `treeReadDeadline`), and one that finishes with a
      // synchronous parse delivers its converged tree with the deadline already
      // behind it. No time has passed since that read and no pixel attempt
      // started, so the tree is current and safe for selector coordinates —
      // hand it back best-effort instead of failing a settle whose tree phase
      // just succeeded. On Android/Chromium/Vega there is not even a probe to
      // consult ({@link getPixelCaptureSupport} resolves synchronously there).
      return { tree: stableTree, converged: false, treeFresh: true, visual };
    }
    if (pixelSupport === "deadline") {
      // Here the probe itself was awaited and consumed the remaining budget:
      // unrevalidated time passed while the screen may have moved — morally a
      // hung capture eating the deadline — so the tree must be marked unsafe
      // for acting callers. Still a best-effort result, never an error: the
      // tree source stayed healthy throughout.
      return { tree: stableTree, converged: false, treeFresh: false, visual };
    }
    if (pixelSupport === "absent") {
      return { tree: stableTree, converged: !pixelsTimedOut, treeFresh: true, visual };
    }

    // Pixel phase. Every outcome flows to the final tree read below: even the
    // first capture can fail only after a long backend timeout, during which
    // the UI tree may have moved. Reserve a short slice of the hard outer
    // deadline so a hung capture cannot consume the only chance to revalidate.
    const pixelDeadline = Math.min(
      hardDeadline - FINAL_TREE_REVALIDATE_RESERVE_MS,
      Date.now() + PIXEL_SETTLE_TIMEOUT_MS
    );
    // Polling for a matching pair belongs to the ordinary phase window, just
    // like tree polling above: on a screen whose pixels never stop, the loop
    // must hand back control while the action-level caller still has budget to
    // retry, not launch captures until the caller's hard deadline. The hard
    // `pixelDeadline` above bounds capture *runtime* only — an in-flight first
    // capture keeps its first-frame-aware budget, and the single warm capture
    // that completes that capture's pair is part of the same allowance (a pair
    // needs two reads, so the phase window closing while the first capture ran
    // must not void the attempt it already paid for).
    const pixelPollDeadline = Math.min(pixelDeadline, phaseDeadline);
    let pixelsConverged = true;
    treeFresh = false;
    const firstPixels =
      pixelSupport === "unknown"
        ? undefined
        : await capturePixelsBefore(env, pixelDeadline, pixelCaptureTimeoutMs(env.device, true));
    if (firstPixels === "aborted") return undefined;
    if (firstPixels === "not-attempted") {
      // The pixel phase never started: `pixelDeadline` was already behind us
      // before a capture could launch. What that means for freshness turns on
      // when the window closed. A pair that converged with the window already
      // spent (`pairConvergedAt >= pixelDeadline`) reached this point through
      // a probe that answered in negligible time — at most the sub-reserve
      // sliver left before the hard deadline — so the tree is still current
      // for selector coordinates and no revalidation read is owed. But a pair
      // that converged while pixel budget remained got here because the
      // awaited probe consumed that budget (a cold iOS runtime-kind lookup is
      // a real `xcrun simctl` round trip): unrevalidated time passed while
      // the screen may have moved — morally the probe-`deadline` return
      // above, merely resolving inside the final-read reserve instead of past
      // it — so the tree must come back unsafe for acting callers. Either way
      // this is not a pixel timeout: `visual` keeps its sticky value
      // ("skipped" by default, or a prior round's verdict) because a phase
      // that never ran must stay distinct from captures that were observed
      // and never matched — the distinction snapshot degradation reporting
      // keys on.
      return {
        tree: stableTree,
        converged: false,
        treeFresh: pairConvergedAt >= pixelDeadline,
        visual,
      };
    }
    if (firstPixels === "deadline") {
      pixelsConverged = false;
      pixelsTimedOut = true;
      visual = "timed-out";
    } else if (firstPixels === undefined) {
      pixelsUnavailable = true;
      visual = "unavailable";
    } else {
      let prevPixels = firstPixels;
      let warmCaptureRan = false;
      for (;;) {
        // Once one warm capture has run, the pair-completion allowance is
        // spent: any further polling round belongs to the ordinary phase
        // window, and a window already closed means the screen provably kept
        // moving for the whole phase — a pixel timeout, handed back while the
        // caller retains retry budget.
        if (warmCaptureRan && Date.now() >= pixelPollDeadline) {
          pixelsConverged = false;
          pixelsTimedOut = true;
          visual = "timed-out";
          break;
        }
        const sleepMs = Math.min(PIXEL_SETTLE_POLL_MS, Math.max(0, pixelDeadline - Date.now()));
        if (sleepMs <= 0) {
          pixelsConverged = false;
          pixelsTimedOut = true;
          visual = "timed-out";
          break;
        }
        if (!(await sleepOrAbort(sleepMs, env.signal))) return undefined;
        const nextPixels = await capturePixelsBefore(
          env,
          pixelDeadline,
          pixelCaptureTimeoutMs(env.device, false)
        );
        warmCaptureRan = true;
        if (nextPixels === "aborted") return undefined;
        if (nextPixels === "deadline" || nextPixels === "not-attempted") {
          // Mid-phase the two zero-progress shapes converge: a capture already
          // ran here without producing a matching pair, so exhausting the
          // budget — inside a capture, or in the instant between the sleep
          // guard above and the next launch — is a pixel timeout, not a phase
          // that never happened.
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
    // Fast pixel phases retain the original phase deadline, giving callers a
    // chance to retry a stale final tree. Once the pixel phase has crossed
    // that window, the read runs on the ordinary source read budget — the
    // same budget every tree-phase read above already gets — so a healthy
    // slow hierarchy read after a phase-bounded pixel timeout is not cut down
    // to the reserve and systematically reported stale. The reserve slice
    // stays the floor (a capture that ran to the hard `pixelDeadline` left
    // exactly that slice) and the hard ceiling stays the roof for the
    // deadline-less case, where the read budget can predate the pixel window
    // closing.
    const finalTreeDeadline =
      Date.now() < phaseDeadline
        ? phaseDeadline
        : Math.min(
            hardDeadline,
            Math.max(treeReadDeadline, Date.now() + FINAL_TREE_REVALIDATE_RESERVE_MS)
          );
    const finalReading = await fetchTreeBefore(env, finalTreeDeadline);
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

    // A restart invalidates a prior `settled` — the screen provably changed
    // after that pixel pair matched. A re-converging restart re-runs the pixel
    // phase and overwrites this; `unavailable` and the sticky timeout stay.
    if (visual === "settled") visual = "skipped";

    if (Date.now() >= phaseDeadline) {
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
 * frame. Only fresh trees are consulted while budget remains; at deadline
 * exhaustion the selector is resolved once, best-effort, from the last valid
 * settled tree — a window of merely slow settles must not read as "element
 * not found". A genuinely absent element still returns undefined.
 *
 * {@link waitForFrameResult} exposes the settle that produced the frame for
 * `snapshot: { cropOn }`; ordinary directive callers keep this frame-only API.
 */
export async function waitForFrame(
  env: ActionEnv,
  selector: FlowSelector
): Promise<DescribeFrame | "aborted" | undefined> {
  return (await waitForFrameResult(env, selector)).frame;
}

export type WaitForFrameResult =
  | { frame: DescribeFrame; settle: SettleResult }
  | { frame: undefined; settle?: SettleResult }
  | { frame: "aborted" };

/**
 * Resolve a selector exactly like {@link waitForFrame}, retaining the settle
 * that supplied its tree. Crop snapshots use the paired result so they can
 * report visual degradation without settling a second time after the frame
 * was chosen.
 */
export async function waitForFrameResult(
  env: ActionEnv,
  selector: FlowSelector
): Promise<WaitForFrameResult> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  let lastTree: DescribeNode | undefined;
  let lastSettle: SettleResult | undefined;
  // An unknown iOS runtime probe is intentionally evicted globally so a later
  // action can recover when the simulator becomes visible. Within one selector
  // wait, though, retrying that same capability on every round only burns the
  // action budget and can turn a healthy terminal tree miss into a probe
  // timeout. Once it degrades, keep this wait tree-only.
  let pixelsUnavailableForWait = false;
  for (;;) {
    if (env.signal?.aborted) return { frame: "aborted" };
    if (Date.now() >= deadline) break;
    const forceTreeOnly: boolean = pixelsUnavailableForWait;
    let settled: SettleResult | undefined;
    try {
      settled = await settleTree(env, {
        absoluteDeadline: deadline,
        ...(forceTreeOnly ? { mode: "tree-only" as const } : {}),
      });
    } catch (err) {
      // A retry round that opens near the action deadline can close its
      // no-read window before the source answers at all, which settleTree
      // types as FlowTreeSettleTimeoutError — explicitly NOT proof of an
      // outage (an in-flight hierarchy read may still succeed after we stop
      // waiting). With a settled tree already in hand from an earlier round,
      // that taxonomy earns the same treatment settleTree itself gives
      // deadline exhaustion after any successful read: fall through to the
      // terminal best-effort resolution below instead of erroring a step
      // whose settles merely ran long. With no tree at all the timeout stays
      // fatal — resolving nothing here would misreport a possibly-alive
      // source as "element not found" — and a proven source outage
      // (FlowTreeSourceUnavailableError) propagates unconditionally.
      if (err instanceof FlowTreeSettleTimeoutError && lastTree !== undefined) break;
      throw err;
    }
    // A forced tree-only retry is still part of a wait whose visual channel
    // was unavailable. Keep that verdict paired with any frame (and terminal
    // miss) produced by the retry instead of reporting visual work as skipped.
    const effectiveSettle: SettleResult | undefined =
      settled && forceTreeOnly ? { ...settled, visual: "unavailable" } : settled;
    if (effectiveSettle) {
      lastTree = effectiveSettle.tree;
      lastSettle = effectiveSettle;
      // Only a completed tree settle establishes a healthy tree-only fallback.
      // A failed post-pixel revalidation must retry the combined path so its
      // unavailable verdict cannot conceal the preceding pixel timeout.
      pixelsUnavailableForWait ||=
        effectiveSettle.converged && effectiveSettle.visual === "unavailable";
    }
    if (effectiveSettle?.treeFresh) {
      const frame = flowSelectorToFrame(effectiveSettle.tree, selector);
      if (frame) return { frame, settle: effectiveSettle };
    } else if (env.signal?.aborted) {
      return { frame: "aborted" }; // settleTree bailed on the abort, not on a blank read
    }
    if (Date.now() >= deadline) break;
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) return { frame: "aborted" };
  }
  // Best-effort last resort: stale coordinates beat failing a step whose
  // settles merely ran long.
  if (!lastTree || !lastSettle) return { frame: undefined, settle: lastSettle };
  const frame = flowSelectorToFrame(lastTree, selector);
  return frame ? { frame, settle: lastSettle } : { frame: undefined, settle: lastSettle };
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
 * starts through an unrelated transition; a round whose settle cannot
 * revalidate the tree is skipped (no scroll, no fingerprint) and the next
 * iteration re-settles instead of failing the step. Later rounds
 * settle only the tree: every increment is momentum-free/settled, and a
 * following tap/type/snapshot performs its own visual settle. Each round then
 * checks the target and, if it isn't fully in view, does one increment.
 * Stopping only once the target has cleared the entry edge (not on the first
 * sliver) is what keeps a following `tap`/`snapshot` off a half-clipped
 * element. If a round's settled tree — fingerprinted within the scrolled
 * region only (the `within` container, or the scroll containers under the
 * gesture anchor when none is named) — is identical to the previous round's,
 * the container has hit its end (or the anchor scrolls nothing): the target is
 * then as visible as it will ever be, so it's accepted wherever it landed —
 * the LAST item sits flush against the far edge and can never clear it, and a
 * genuinely stuck partial can't be improved either. A target already fully on
 * screen returns immediately (no scroll).
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
      // A stale settle — round 0's combined pixel wait, or any round's tree
      // read outliving the read budget — is skipped and re-settled: not
      // scrolling keeps the content in place, not fingerprinting keeps the
      // end-of-scroll check honest.
      continue;
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
export function offscreenHint(sel: FlowSelector): string {
  return `no visible element matched selector ${describeSelector(sel)} — if it is off-screen, add a scroll-to step before this one`;
}

/** Execute one selector-acting directive (`tap` / `long-press` / `type` / `await` / `assert` / `scroll-to` / `pinch` / `rotate`). */
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
 * Resolve a gesture target (`tap`/`long-press`) to a normalized point: a
 * selector resolves to its frame centre (settled tree + auto-wait); raw
 * coordinates still wait for the same combined settle before dispatch, with
 * {@link waitForFrame}'s patience: a settle without a usable result is
 * retried until the shared action deadline. The literal x/y never consult
 * the tree, so a fresh tree or settled pixels both count as usable — and at
 * deadline exhaustion the gesture dispatches anyway, the settle being
 * best-effort stabilization rather than a precondition.
 * Coordinate targets are the fallback for elements with no stable selector
 * (e.g. an unlabeled view), not an escape hatch from full-hierarchy settling:
 * they bypass selector resolution only — a tree-source outage throw from
 * settleTree propagates as ever.
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
    const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
    for (;;) {
      // A sleep can land exactly on the deadline. A zero-budget settle is a
      // doomed round — no read can start, so it can only throw
      // FlowTreeSettleTimeoutError, which the catch below turns into this same
      // break to best-effort dispatch; skip the wasted call.
      if (Date.now() >= deadline) break;
      let settled: SettleResult | undefined;
      try {
        settled = await settleTree(env, { absoluteDeadline: deadline });
      } catch (err) {
        // Literal coordinates do not consume the tree. If no hierarchy read
        // completed before the action's hard deadline, settling exhausted its
        // best-effort budget and the gesture may still dispatch. A completed
        // source failure proves an outage and every other error remains fatal.
        if (err instanceof FlowTreeSettleTimeoutError) break;
        throw err;
      }
      if (!settled) return { fail: ABORTED_OUTCOME };
      // A fresh tree proves the settle's view is current; settled pixels
      // prove the screen itself stopped (settleTree never leaks a pre-restart
      // "settled"). Either one is enough for coordinates no selector reads.
      if (settled.treeFresh || settled.visual === "settled") {
        return { x: target.x, y: target.y };
      }
      if (Date.now() >= deadline) break;
      const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
      if (!(await sleepOrAbort(sleepMs, env.signal))) return { fail: ABORTED_OUTCOME };
    }
    // Deadline exhausted without a usable settle (e.g. an endless animation):
    // the settle is best-effort, so dispatch anyway — only a dispatch failure
    // may fail the step. Aborts and outages already short-circuited above.
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
 * Best-effort screen aspect (width / height) for the rotate directive's
 * physical-circle geometry. One dedicated tree read instead of threading
 * dimensions through settleTree/waitForFrame: the settle loop already reads
 * the tree several times per step, so the extra fetch is noise, and the
 * resolution path every other directive shares stays untouched.
 */
async function fetchScreenAspect(env: ActionEnv): Promise<number | undefined> {
  try {
    const { screen } = await fetchFlowTree(env.registry, env.device);
    return screen && screen.width > 0 && screen.height > 0
      ? screen.width / screen.height
      : undefined;
  } catch {
    return undefined; // fail soft: the caller falls back to the legacy ellipse
  }
}

/**
 * Rotate by `by` degrees (+ clockwise) about a selector's frame centre
 * (settled tree + auto-wait, like tap) or the screen centre. One continuous
 * gesture — fingers orbit the fixed centroid at a constant physical radius,
 * so any angle dispatches without decomposition or settle delays, and the
 * angular delta is exact with zero pan/pinch coupling. The initial finger
 * axis is the safer of horizontal and vertical (see flow-rotate-geometry);
 * duration derives from the angle at the fixed ~90°/300ms pace — `by` is
 * bounded at parse. NOT the `rotate` tool — that changes device orientation.
 */
async function runRotate(
  env: ActionEnv,
  step: { selector?: FlowSelector; by: number }
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
