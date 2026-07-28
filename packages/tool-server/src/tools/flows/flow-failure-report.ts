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

/** Everything the assembler needs from the run. */
export interface DiagnosticsEnv extends ActionEnv {
  /** The top-level flow name — used only to label the spilled artifacts. */
  topFlowName?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
async function withBudget<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
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
    return winner.ok ? winner.value : fallback();
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  try {
    report.failure = await withBudget(
      buildFailure(env, report, meta, evidence),
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
    message: scrub(report.reason ?? ""),
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
      ...(evidence?.lastTrustedReadAt !== undefined
        ? { lastTrustedReadAt: evidence.lastTrustedReadAt }
        : {}),
      ...(evidence?.darkTailMs !== undefined ? { darkTailMs: evidence.darkTailMs } : {}),
    },
    ...(evidence?.cause !== undefined ? { cause: evidence.cause } : {}),
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
  evidence: DirectiveEvidence | undefined
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
  if (evidence?.treeError !== undefined) {
    return {
      screen: {
        state: "unavailable",
        reason: "never-readable",
        detail: truncateUtf8Field(scrub(evidence.treeError), 512),
        hint: "the tree source never produced a readable screen — this is an environment failure, not a broken step",
      },
      scrub,
    };
  }
  if (env.signal?.aborted) {
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
        detail: truncateUtf8Field(scrub(errMsg(err)), 512),
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
  let alternatives: FlowFailureSelector["alternatives"] = [];
  try {
    alternatives = flowSelectorAlternatives(sel);
  } catch {
    alternatives = [];
  }
  const unresolvedScope = tree !== undefined ? diagnoseScope(tree, sel) : undefined;
  const selector: FlowFailureSelector = {
    described: truncateUtf8Field(scrub(describeSelector(sel))),
    fields: JSON.parse(scrub(JSON.stringify(fields))) as Record<string, unknown>,
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
  if (matches === undefined) {
    return supplied === undefined
      ? undefined
      : ({ matchCount: 0, visibleMatchCount: 0, ...supplied } as FlowFailureObservation);
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-flow-failure-"));
    const file = path.join(dir, `${stem}-tree.txt`);
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
  evidence: DirectiveEvidence | undefined
): Promise<FlowStepFailure> {
  const { screen, tree, scrub } = await resolveScreen(env, evidence);
  const failure = baseFailure(report, meta, evidence, screen);

  if (evidence?.expected !== undefined) {
    failure.expected = evidence.expected;
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
    if (selectorBlock.unresolvedScope !== undefined) {
      failure.code = "selector-scope-unresolved";
      failure.category = FLOW_FAILURE_CATEGORY["selector-scope-unresolved"];
      failure.determinacy = determinacyOf("selector-scope-unresolved");
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
  if (tree !== undefined && evidence?.selector !== undefined && !resolvedSomething) {
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
  if (failure.screen.state !== "available") return failure;

  const full = failure;
  const trimmed: FlowStepFailure = {
    ...failure,
    screen: {
      state: "unavailable",
      reason: "omitted-for-size",
      detail: `the element list was ${serialized} bytes, over the ${FLOW_FAILURE_BYTE_LIMIT}-byte report budget`,
      ...(failure.tree !== undefined
        ? { hint: "read the `tree` artifact for the full element list" }
        : {}),
    },
  };
  const omittedBytes = serialized - safeSize(trimmed);
  trimmed.overflow = { omittedBytes };

  const store = env.ctx?.artifacts;
  if (store) {
    try {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-flow-failure-"));
      const file = path.join(dir, `${stem}-failure.json`);
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
  const signal = getFailureSignal(err);
  const cause = signal ? { cause: { code: signal.error_code, message: errMsg(err) } } : {};
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
