/**
 * Assembly of {@link FlowStepFailure} — the structured diagnostics attached to
 * the one step a run can fail on.
 *
 * The whole module is FAIL-SOFT by construction. It runs between
 * `execLeafStep` returning and `pushReport`, on a step that has already been
 * decided; nothing it does may change a verdict, throw into the runner, or
 * delay the report past {@link FLOW_DIAGNOSTICS_BUDGET_MS}. Every failure mode
 * degrades the payload (a `screen: { state: "unavailable" }`, a missing
 * screenshot) rather than the run. That is not defensive habit: the test
 * harness invokes the tool with NO `ctx` at all and a `screenshot` stub that
 * returns `{ ok: true }`, so a single unguarded `requireArtifacts` here would
 * break ~20 existing test files.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ARTIFACT_MARKER, getFailureSignal } from "@argent/registry";
import type { ArtifactHandle } from "../../artifacts";
import type { DescribeNode } from "../describe/contract";
import { fetchFlowTree } from "./flow-tree";
import { invokeOnDevice, flowSelectorAlternatives, type ActionEnv } from "./flow-actions";
import { rankCandidates, diagnoseScope } from "./flow-candidates";
import { describeSelector, type FlowSelector } from "./flow-utils";
import {
  createSecretScrubber,
  determinacyOf,
  flattenForReport,
  isActionableNode,
  isTreeSourceError,
  projectNode,
  truncateUtf8Field,
  FLOW_DIAGNOSTICS_BUDGET_MS,
  FLOW_FAILURE_BYTE_LIMIT,
  FLOW_FAILURE_CANDIDATE_LIMIT,
  FLOW_FAILURE_CATEGORY,
  FLOW_FAILURE_ELEMENT_LIMIT,
  type DirectiveEvidence,
  type FlowFailureCode,
  type FlowFailureExpectation,
  type FlowFailureObservation,
  type FlowFailureScreen,
  type FlowFailureSelector,
  type FlowStepFailure,
} from "./flow-failure";
import { assertText, isVisible, firstInReadingOrder, nodeText } from "../../utils/ui-tree-match";
import type { StepReport } from "./flow-run";

/**
 * A step report on its way out of `execLeafStep`, still carrying the live
 * `DescribeNode`s the directive collected. The assembler consumes and DELETES
 * `evidence`, so a whole UI tree can never ride out on the wire or the NDJSON
 * progress stream.
 */
export type LeafOutcome = StepReport & { evidence?: DirectiveEvidence };

/**
 * Everything the assembler needs from the run. An alias rather than an
 * extension: the capture reads the device and the artifact store and nothing
 * else about the run, and naming that keeps it true.
 */
export type DiagnosticsEnv = ActionEnv;

/**
 * A tree-source error is the whole diagnosis when it appears, and the helpers
 * spell theirs at length (what broke, plus how to resolve it), so it gets a
 * larger allowance than an ordinary projected field.
 */
const TREE_ERROR_DETAIL_LIMIT = 512;

/**
 * One directory for every failure artifact this process writes, with unique
 * filenames inside it — NOT an `mkdtemp` per run. A registered artifact's host
 * path must outlive the call (a co-located client reads it in place), so these
 * files cannot be swept the way `flow-visual.ts` sweeps its diff scratch; a
 * per-run directory therefore accreted forever on a host-wide, never-exiting
 * tool-server. A shared directory keeps the entry count constant, which is the
 * same shape the other long-lived temp writers here use.
 */
let evidenceDir: Promise<string> | undefined;
function failureEvidenceDir(): Promise<string> {
  evidenceDir ??= (async () => {
    const dir = path.join(os.tmpdir(), "argent-flow-failure");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  })();
  return evidenceDir;
}

/**
 * Longest failure message that reaches the wire. `message` mirrors
 * `StepReport.reason`, which quotes on-screen text — and the flow adapters
 * hoist a container's WHOLE subtree text, so one `text` mismatch against a
 * screen-sized container produced a six-figure-byte reason. It ships twice
 * (reason + message) on every NDJSON progress event, so this is the field that
 * has to be bounded for the payload budget to mean anything. Generous enough
 * that no ordinary message is touched.
 */
const MESSAGE_BYTE_LIMIT = 4 * 1024;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Scrub every string INSIDE a structure rather than its serialized form.
 * `JSON.stringify` escapes quotes, backslashes and newlines, so a secret
 * containing any of them is not found in the serialized text and rides out
 * intact — the mask has to be applied to the values themselves. Strings are
 * field-capped on the way through, which is also what bounds the otherwise
 * unbounded selector projections.
 */
function scrubDeep(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return truncateUtf8Field(scrub(value));
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = scrubDeep(inner, scrub);
    return out;
  }
  return value;
}

function isArtifactHandle(value: unknown): value is ArtifactHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[ARTIFACT_MARKER] === true &&
    typeof (value as ArtifactHandle).hostPath === "string"
  );
}

/**
 * Run `work` against a wall-clock ceiling, falling back rather than waiting.
 * The loser is explicitly caught: a rejection that arrives after the race has
 * been decided would otherwise surface as an unhandled rejection and take the
 * tool-server down over diagnostics.
 */
async function withBudget<T>(
  start: (token: CaptureToken) => Promise<T>,
  ms: number,
  fallback: () => T
): Promise<T> {
  // The race decides which VALUE is reported; the token is what actually stops
  // the losing work. Without it a timed-out capture kept running against a run
  // that had already torn down — invoking `screenshot` after the status bar was
  // restored and the chromium instance killed, and registering artifacts
  // nothing would ever reference (the store has no eviction).
  const token: CaptureToken = { cancelled: false };
  const work = start(token);
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
    // Diagnostics must never hold the process open past the run.
    timer.unref?.();
  });
  try {
    const winner = await Promise.race([
      work.then((value) => ({ ok: true as const, value })),
      expiry,
    ]);
    if (winner.ok) return winner.value;
    token.cancelled = true;
    return fallback();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Cooperative cancellation for the capture; see {@link withBudget}. */
interface CaptureToken {
  cancelled: boolean;
}

/**
 * Attach diagnostics to a failing step report, in place.
 *
 * Called at each of the three failure-emission sites AFTER `state.stopped` is
 * set (the run is unambiguously over) and BEFORE `pushReport` — `pushReport` is
 * the single choke point feeding `ctx.emitProgress`, so attaching afterwards
 * would ship the failing step down the live stream without its failure object.
 *
 * The cost is one capture per RUN, not per step: the runner hard-stops at the
 * first non-passing leaf, so at most one report ever reaches here.
 */
export async function attachFailureDiagnostics(
  env: DiagnosticsEnv,
  report: LeafOutcome,
  meta: { startedAt: number; ordinal: number }
): Promise<void> {
  const evidence = report.evidence;
  // Off the report before anything can throw: a live DescribeNode must not
  // reach the wire even if assembly fails halfway.
  delete report.evidence;
  // Scrub the REASON, not just the copy of it on the failure object. A failure
  // reason quotes what was on screen (`assertReason` prints the element's
  // text), so it is exactly where a credential the app echoed back would land
  // — and `reason` ships on the wire whether or not anything reads `failure`.
  // Scrubbing only the copy would leave the leak open while looking closed.
  // Doing it here also preserves the invariant every renderer relies on:
  // `failure.message` is byte-identical to `reason`.
  if (report.reason !== undefined) {
    const scrubbed = createSecretScrubber()(report.reason);
    if (scrubbed !== report.reason) report.reason = scrubbed;
  }
  try {
    report.failure = await withBudget(
      (token) => buildFailure(env, report, meta, evidence, token),
      FLOW_DIAGNOSTICS_BUDGET_MS,
      () => baseFailure(report, meta, evidence, { state: "unavailable", reason: "capture-timeout" })
    );
  } catch {
    // Assembly itself broke. Emit the minimum honest payload rather than
    // nothing — the code and message alone still beat a bare reason string.
    try {
      report.failure = baseFailure(report, meta, evidence, {
        state: "unavailable",
        reason: "read-failed",
        ...(evidence?.treeError !== undefined ? { detail: evidence.treeError } : {}),
      });
    } catch {
      /* diagnostics must never change a verdict */
    }
  }
}

/** The skeleton every failure shares — valid on its own when capture degrades. */
function baseFailure(
  report: LeafOutcome,
  meta: { startedAt: number; ordinal: number },
  evidence: DirectiveEvidence | undefined,
  screen: FlowFailureScreen
): FlowStepFailure {
  const scrub = createSecretScrubber();
  const code: FlowFailureCode = evidence?.code ?? "unclassified";
  return {
    version: 1,
    code,
    category: FLOW_FAILURE_CATEGORY[code] ?? "tool",
    determinacy: determinacyOf(code),
    message: truncateUtf8Field(scrub(report.reason ?? ""), MESSAGE_BYTE_LIMIT),
    ...(evidence?.hint !== undefined ? { hint: scrub(evidence.hint) } : {}),
    step: {
      index: report.index,
      ordinal: meta.ordinal,
      kind: report.kind,
      flow: report.flow ?? "",
      ...(report.target !== undefined ? { target: truncateUtf8Field(scrub(report.target)) } : {}),
      ...(report.depth !== undefined ? { depth: report.depth } : {}),
    },
    screen,
    candidates: [],
    candidateCount: 0,
    timing: {
      startedAt: meta.startedAt,
      durationMs: report.durationMs ?? Date.now() - meta.startedAt,
      ...(evidence?.budgetMs !== undefined ? { budgetMs: evidence.budgetMs } : {}),
      ...(evidence?.attempts !== undefined ? { attempts: evidence.attempts } : {}),
      ...(evidence?.trustedAttempts !== undefined
        ? { trustedAttempts: evidence.trustedAttempts }
        : {}),
      ...(evidence?.lastTrustedReadAt !== undefined
        ? { lastTrustedReadAt: evidence.lastTrustedReadAt }
        : {}),
      ...(evidence?.darkTailMs !== undefined ? { darkTailMs: evidence.darkTailMs } : {}),
    },
    // The underlying error text is device/helper prose like any other: it can
    // quote what was on screen, so it gets the same mask and the same cap as
    // the message beside it.
    ...(evidence?.cause !== undefined
      ? {
          cause: {
            code: truncateUtf8Field(evidence.cause.code, 128),
            message: truncateUtf8Field(scrub(evidence.cause.message), MESSAGE_BYTE_LIMIT),
          },
        }
      : {}),
  };
}

/**
 * The screen the failure report shows, and the tree candidates are ranked
 * against — always the SAME tree, so the element count a report states and the
 * suggestions it makes can never describe different reads.
 *
 * Ordering rules, both load-bearing:
 *  - The directive's own last trusted read wins. It is the screen that
 *    actually failed; anything read later has let the app move on.
 *  - A recorded tree-source error suppresses the post-hoc read entirely. A
 *    later read that happens to succeed would render as a perfectly healthy
 *    `available` screen, and an operator would conclude the tree source was
 *    fine when the step failed precisely because it wasn't.
 */
async function resolveScreen(
  env: DiagnosticsEnv,
  evidence: DirectiveEvidence | undefined,
  token: CaptureToken
): Promise<{ screen: FlowFailureScreen; tree?: DescribeNode; scrub: (t: string) => string }> {
  const scrub = createSecretScrubber();
  type AvailableScreen = Extract<FlowFailureScreen, { state: "available" }>;
  const project = (
    tree: DescribeNode,
    base: Omit<AvailableScreen, "state" | "elements" | "elementCount" | "truncated">
  ): { screen: FlowFailureScreen; tree: DescribeNode; scrub: (t: string) => string } => {
    const actionable = flattenForReport(tree).filter(isActionableNode);
    const elements = actionable
      .slice(0, FLOW_FAILURE_ELEMENT_LIMIT)
      .map((n) => projectNode(n, scrub));
    const screen: FlowFailureScreen = {
      state: "available",
      ...base,
      elementCount: actionable.length,
      elements,
      ...(actionable.length > elements.length ? { truncated: true as const } : {}),
    };
    return { screen, tree, scrub };
  };

  if (evidence?.tree !== undefined) {
    return project(evidence.tree, {
      source: evidence.source ?? "native-devtools",
      capturedAt: "at-failure",
      ageMs: evidence.readAt !== undefined ? Math.max(0, Date.now() - evidence.readAt) : 0,
      ...(evidence.screenSize !== undefined ? { size: evidence.screenSize } : {}),
      ...(evidence.treeError !== undefined ? { readError: scrub(evidence.treeError) } : {}),
    });
  }
  // An INDETERMINATE verdict means argent never got a trustworthy look at the
  // screen. A recorded `treeError` covers the case where reads THREW — but a
  // read can also come back blind (empty tree plus a degraded hint), which
  // succeeds and so records no error at all. Gating on the verdict rather than
  // on the error covers both: without this, a post-hoc read that happens to
  // succeed rendered `screen: available, elementCount: 0` beside the message
  // "every read of the UI tree was empty or degraded" — telling the operator
  // the app was blank when argent simply could not see it.
  if (evidence?.code !== undefined && determinacyOf(evidence.code) === "indeterminate") {
    return {
      screen: {
        state: "unavailable",
        reason: "never-readable",
        ...(evidence.treeError !== undefined
          ? { detail: truncateUtf8Field(scrub(evidence.treeError), TREE_ERROR_DETAIL_LIMIT) }
          : {}),
        hint: "argent could not read the screen for this step — an environment failure, not a broken step",
      },
      scrub,
    };
  }
  if (evidence?.treeError !== undefined) {
    return {
      screen: {
        state: "unavailable",
        reason: "never-readable",
        detail: truncateUtf8Field(scrub(evidence.treeError), TREE_ERROR_DETAIL_LIMIT),
        hint: "the tree source never produced a readable screen — this is an environment failure, not a broken step",
      },
      scrub,
    };
  }
  if (env.signal?.aborted || token.cancelled) {
    return { screen: { state: "unavailable", reason: "aborted" }, scrub };
  }
  try {
    const data = await fetchFlowTree(env.registry, env.device);
    return project(data.tree, {
      source: data.source,
      capturedAt: "after-failure",
      ageMs: 0,
      ...(data.screen !== undefined ? { size: data.screen } : {}),
    });
  } catch (err) {
    return {
      screen: {
        state: "unavailable",
        reason: "read-failed",
        detail: truncateUtf8Field(scrub(errMsg(err)), TREE_ERROR_DETAIL_LIMIT),
      },
      scrub,
    };
  }
}

/** The selector block: what the runner looked for, spelled the way it looked. */
function buildSelector(
  evidence: DirectiveEvidence,
  tree: DescribeNode | undefined,
  scrub: (t: string) => string
): { selector: FlowFailureSelector; unresolvedScope?: "within" | "after" | "next" } | undefined {
  const sel: FlowSelector | undefined = evidence.selector;
  if (sel === undefined) return undefined;
  const { loose, ...fields } = sel;
  // `alternatives` is the answer to "what did it actually search for", which
  // the prose has never carried: a bare-string `tap: foo` looked for an
  // identifier `foo` AND text `foo`, in that order.
  let alternatives: FlowFailureSelector["alternatives"];
  try {
    // Scrubbed like every other projection of the selector: the alternatives
    // are the selector's own fields re-spelled, so a `{{secret:…}}`-derived
    // value in the flow would ride out here even though `fields` and
    // `described` beside it were masked.
    alternatives = scrubDeep(
      flowSelectorAlternatives(sel),
      scrub
    ) as FlowFailureSelector["alternatives"];
  } catch {
    alternatives = [];
  }
  const unresolvedScope = tree !== undefined ? diagnoseScope(tree, sel) : undefined;
  const selector: FlowFailureSelector = {
    described: truncateUtf8Field(scrub(describeSelector(sel))),
    fields: scrubDeep(fields, scrub) as Record<string, unknown>,
    loose: loose === true,
    alternatives,
    ...(unresolvedScope !== undefined ? { unresolvedScope } : {}),
  };
  return { selector, ...(unresolvedScope !== undefined ? { unresolvedScope } : {}) };
}

/**
 * What was actually observed, derived from ONE source (`evidence.matches`) so
 * the counts, the listed invisible matches and the quoted text cannot describe
 * different reads. Snapshot-only numbers ride in on `evidence.observation`,
 * which the assembler cannot derive.
 */
function buildObservation(
  evidence: DirectiveEvidence,
  scrub: (t: string) => string
): FlowFailureObservation | undefined {
  const supplied = evidence.observation;
  const matches = evidence.matches;
  // No matches recorded means no selector was resolved (a snapshot, a launch, a
  // geometry failure). Emit only what the site supplied — a fabricated
  // `matchCount: 0` reads as "the selector found nothing", a different and
  // wrong diagnosis on a failure that never had a selector.
  if (matches === undefined) {
    return supplied === undefined ? undefined : { ...supplied };
  }
  const visible = matches.filter(isVisible);
  const out: FlowFailureObservation = {
    matchCount: matches.length,
    visibleMatchCount: visible.length,
  };
  // The zero-area matches ARE the diagnosis for selector-not-visible, and are
  // deliberately kept out of `candidates` — which means "other elements you
  // might have meant", a different question.
  if (matches.length > 0 && visible.length === 0) {
    out.invisibleMatches = matches
      .slice(0, FLOW_FAILURE_CANDIDATE_LIMIT)
      .map((n) => projectNode(n, scrub));
  }
  // Only a `text` condition read an element's text; quoting one for any other
  // condition would invent an expectation the step never had.
  const isTextCondition =
    evidence.expected?.kind === "condition" && evidence.expected.condition === "text";
  if (isTextCondition) {
    const first = firstInReadingOrder(visible) ?? firstInReadingOrder(matches);
    if (first !== undefined) {
      out.element = projectNode(first, scrub);
      out.text = truncateUtf8Field(scrub(assertText(first)));
      const own = nodeText(first);
      if (own && own !== assertText(first)) out.ownText = truncateUtf8Field(scrub(own));
    }
  }
  return { ...out, ...supplied };
}

/**
 * Register the full element dump as a text artifact. Never an inline field: a
 * screen-sized tree would bloat every `--json` report and every NDJSON progress
 * event, on every failure. Returns undefined when there is no artifact store
 * (the unit-test path) or the write fails.
 */
async function registerTreeDump(
  env: DiagnosticsEnv,
  tree: DescribeNode,
  stem: string,
  scrub: (t: string) => string
): Promise<ArtifactHandle | undefined> {
  const store = env.ctx?.artifacts;
  if (!store) return undefined;
  try {
    const lines = flattenForReport(tree).map((node) => {
      const n = projectNode(node, scrub);
      const bits = [
        n.role,
        n.identifier !== undefined ? `id=${n.identifier}` : undefined,
        n.label !== undefined ? `label=${JSON.stringify(n.label)}` : undefined,
        n.value !== undefined ? `value=${JSON.stringify(n.value)}` : undefined,
        n.text !== undefined ? `text=${JSON.stringify(n.text)}` : undefined,
        n.flags !== undefined ? `[${n.flags}]` : undefined,
        `at ${n.frame.x},${n.frame.y} ${n.frame.width}x${n.frame.height}`,
      ].filter((b) => b !== undefined);
      return bits.join("  ");
    });
    const dir = await failureEvidenceDir();
    // The stem repeats across runs, so the filename carries a unique segment;
    // the client materializes by the DECLARED filename, which stays stable.
    const file = path.join(dir, `${stem}-tree-${randomUUID()}.txt`);
    await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
    return await store.register(file, { mimeType: "text/plain", filename: `${stem}-tree.txt` });
  } catch {
    return undefined;
  }
}

/**
 * Full-resolution capture at the moment of failure — the exact call
 * `flow-visual.ts` already makes for a snapshot baseline.
 *
 * Skipped in three cases, each for its own reason: an aborted run (a post-abort
 * invoke would reject, and a cancelled run says nothing about the app), a
 * missing artifact store (the unit-test path), and a step that already carries
 * `artifacts.current` — a snapshot failure, where a second capture would show a
 * DIFFERENT screen than the one that was diffed.
 */
async function captureScreenshot(
  env: DiagnosticsEnv,
  report: LeafOutcome
): Promise<ArtifactHandle | undefined> {
  if (env.signal?.aborted) return undefined;
  if (!env.ctx?.artifacts) return undefined;
  if (report.artifacts?.current !== undefined) return undefined;
  try {
    const shot = await invokeOnDevice(env, "screenshot", {
      scale: 1.0,
      includeImageInContext: false,
    });
    const image = (shot as { image?: unknown } | undefined)?.image;
    return isArtifactHandle(image) ? image : undefined;
  } catch {
    return undefined;
  }
}

async function buildFailure(
  env: DiagnosticsEnv,
  report: LeafOutcome,
  meta: { startedAt: number; ordinal: number },
  evidence: DirectiveEvidence | undefined,
  token: CaptureToken
): Promise<FlowStepFailure> {
  const { screen, tree, scrub } = await resolveScreen(env, evidence, token);
  const failure = baseFailure(report, meta, evidence, screen);

  // The platform is what turns a launch / tree-source failure from a puzzle
  // into a diagnosis — "could not connect to native devtools" means something
  // different on ios than on android — and it is the one piece of run context
  // no renderer can derive from the step alone.
  failure.data = { ...failure.data, platform: env.device.platform };

  if (evidence?.expected !== undefined) {
    // Flow-derived text, masked like `message`/`described`/`fields`: an
    // expectation can quote a value the author templated from a secret.
    failure.expected = scrubDeep(evidence.expected, scrub) as FlowFailureExpectation;
  } else if (isGestureKind(report.kind)) {
    // A gesture directive knows no expectation beyond itself; naming it here
    // keeps every failure's `expected` slot populated without each call site
    // restating its own kind.
    failure.expected = { kind: "gesture", gesture: report.kind };
  }

  const selectorBlock = evidence !== undefined ? buildSelector(evidence, tree, scrub) : undefined;
  if (selectorBlock !== undefined) {
    failure.selector = selectorBlock.selector;
    // A scope that resolved to nothing means the target was never looked for
    // where the report says it was. Today the operator gets a message about
    // the TARGET and goes hunting in the wrong place.
    // Only ever REFINE a determinate selector failure. An indeterminate verdict
    // means argent could not see the screen, so "your scope matched nothing" is
    // a claim about a tree nobody trusts — and rewriting the code, category and
    // determinacy together left the three self-consistent while contradicting
    // the message beside them. `determinacy` is the one field a CI operator
    // branches on for retry-vs-fix, and this turned "re-run" into "your flow is
    // wrong" on exactly the mid-run devtools drop the tier exists for.
    if (selectorBlock.unresolvedScope !== undefined && failure.determinacy === "determinate") {
      failure.code = "selector-scope-unresolved";
      failure.category = FLOW_FAILURE_CATEGORY["selector-scope-unresolved"];
      failure.hint =
        `the ${selectorBlock.unresolvedScope} scope matched no element, so the target was never ` +
        `searched for — fix the scope selector first`;
    }
  }

  const observation = evidence !== undefined ? buildObservation(evidence, scrub) : undefined;
  if (observation !== undefined) failure.actual = observation;

  // Candidates answer "which element did you MEAN instead", so they are only
  // meaningful when the selector resolved to nothing visible. A `text`
  // mismatch or an unmet `hidden` DID find its element — ranking there just
  // suggests the element the step already matched, which reads as advice to
  // make a change that would do nothing, and costs the LLM repair loop its
  // most valuable slot. Those shapes are diagnosed by `expected`/`actual`
  // instead.
  const resolvedSomething = (observation?.visibleMatchCount ?? 0) > 0;
  // `snapshot-crop-empty` is the case the count alone cannot catch: the
  // selector DID resolve (that is how the crop got a frame), the region just
  // rounds to zero pixels — so suggesting other elements answers a question
  // nobody asked. Category is the honest test: only a selector-shaped failure
  // has a "did you mean" answer.
  const wantsCandidates =
    failure.category === "selector" ||
    failure.category === "scroll" ||
    failure.category === "gesture";
  if (
    tree !== undefined &&
    evidence?.selector !== undefined &&
    !resolvedSomething &&
    wantsCandidates
  ) {
    const ranked = rankCandidates(tree, evidence.selector, {
      gesture: isGestureKind(report.kind),
      scrub,
      limit: FLOW_FAILURE_CANDIDATE_LIMIT,
    });
    failure.candidates = ranked.candidates;
    failure.candidateCount = ranked.total;
  }

  const stem = `step-${String(meta.ordinal).padStart(2, "0")}`;
  const screenshot = await captureScreenshot(env, report);
  if (screenshot !== undefined) failure.screenshot = screenshot;
  if (tree !== undefined) {
    const dump = await registerTreeDump(env, tree, stem, scrub);
    if (dump !== undefined) failure.tree = dump;
  }

  return applyByteBudget(env, failure, stem);
}

const GESTURE_KINDS = new Set(["tap", "long-press", "type", "pinch", "rotate"]);
function isGestureKind(kind: string): boolean {
  return GESTURE_KINDS.has(kind);
}

/**
 * Keep the serialized payload under {@link FLOW_FAILURE_BYTE_LIMIT}.
 *
 * The element list is the only unbounded part worth dropping — code, message,
 * selector, observation, candidates and the artifact handles are what make the
 * report actionable, and together they are small. When the list goes, the full
 * payload is registered as a JSON artifact so nothing is actually lost; if even
 * that registration fails, `overflow` still says the detail was dropped rather
 * than pretending it wasn't.
 */
async function applyByteBudget(
  env: DiagnosticsEnv,
  failure: FlowStepFailure,
  stem: string
): Promise<FlowStepFailure> {
  const serialized = safeSize(failure);
  if (serialized <= FLOW_FAILURE_BYTE_LIMIT) return failure;

  const full = failure;
  const trimmed: FlowStepFailure = { ...failure };
  // Shed in increasing order of diagnostic value, RE-MEASURING after each step
  // rather than assuming the first cut was enough. Dropping only the element
  // list left a payload eight times over budget whenever the weight was
  // somewhere else, while `overflow.omittedBytes` cheerfully reported the few
  // hundred bytes that had actually gone.
  if (trimmed.screen.state === "available") {
    trimmed.screen = {
      state: "unavailable",
      reason: "omitted-for-size",
      detail: `the report was ${serialized} bytes, over the ${FLOW_FAILURE_BYTE_LIMIT}-byte budget`,
      ...(failure.tree !== undefined
        ? { hint: "read the `tree` artifact for the full element list" }
        : {}),
    };
  }
  if (safeSize(trimmed) > FLOW_FAILURE_BYTE_LIMIT && trimmed.actual?.invisibleMatches) {
    const { invisibleMatches: _dropped, ...rest } = trimmed.actual;
    trimmed.actual = rest;
  }
  if (safeSize(trimmed) > FLOW_FAILURE_BYTE_LIMIT && trimmed.candidates.length > 0) {
    trimmed.candidates = [];
  }
  if (safeSize(trimmed) > FLOW_FAILURE_BYTE_LIMIT && trimmed.selector !== undefined) {
    // Keep `described` — it is what the message quotes — and drop the machine
    // projections beside it.
    trimmed.selector = { ...trimmed.selector, fields: {}, alternatives: [] };
  }
  const omittedBytes = Math.max(0, serialized - safeSize(trimmed));
  trimmed.overflow = { omittedBytes };

  const store = env.ctx?.artifacts;
  if (store) {
    try {
      const dir = await failureEvidenceDir();
      const file = path.join(dir, `${stem}-failure-${randomUUID()}.json`);
      await fs.writeFile(file, JSON.stringify(full, null, 2), "utf8");
      trimmed.overflow = {
        omittedBytes,
        artifact: await store.register(file, {
          mimeType: "application/json",
          filename: `${stem}-failure.json`,
        }),
      };
    } catch {
      // The report already says the detail was dropped; that is the honest
      // outcome and must not be upgraded into a run failure.
    }
  }
  return trimmed;
}

function safeSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

/**
 * Classify a directive that THREW rather than reporting a failed outcome.
 *
 * A tree-source outage and a genuinely broken step are indistinguishable from
 * the message alone, and they call for opposite responses — re-run vs. edit the
 * flow — so the marker `settleTree` attaches is what decides. The underlying
 * registry code rides along on `cause` so a `NATIVE_DEVTOOLS_NOT_CONNECTED`
 * under a flow step surfaces in both spellings.
 */
export function evidenceFromThrow(err: unknown): DirectiveEvidence {
  const cause = causeOf(err);
  if (isTreeSourceError(err)) {
    return {
      code: "tree-source-unavailable",
      treeError: errMsg(err),
      hint: "the UI tree source failed for the whole step window — re-run; do not edit the flow",
      ...cause,
    };
  }
  return { code: "directive-threw", ...cause };
}

/** The registry failure signal of a thrown error, shaped for {@link DirectiveEvidence}. */
export function causeOf(err: unknown): Pick<DirectiveEvidence, "cause"> {
  const signal = getFailureSignal(err);
  return signal ? { cause: { code: signal.error_code, message: errMsg(err) } } : {};
}
