/**
 * Failure taxonomy and wire shape for a flow step that did not pass.
 *
 * A failing flow used to carry exactly one prose string (`StepReport.reason`).
 * In CI that is a dead end: the device is gone, the app has moved on, and the
 * only recourse is a re-run that often doesn't reproduce. `FlowStepFailure` is
 * the structured counterpart — a classified cause, what was actually on
 * screen, the closest matching elements, and handles to a screenshot and a full
 * element dump captured at the moment of failure.
 *
 * This is a SEPARATE code space from `@argent/registry`'s `FAILURE_CODES`.
 * That registry is the telemetry space: every value is an `error_code` on a
 * thrown `FailureError`, sampled into telemetry cardinality. Step failures are
 * report outcomes, not thrown errors. When a thrown error underlies a step
 * failure its registry code is preserved separately on {@link
 * FlowStepFailure.cause}, so e.g. a `NATIVE_DEVTOOLS_NOT_CONNECTED` under a
 * flow step surfaces both spellings.
 *
 * Codes are kebab-case because they are rendered verbatim to humans and LLMs
 * (`selector-not-found: no visible element matched …`).
 */

import type { DescribeFrame, DescribeNode, DescribeSource } from "../describe/contract";
import type { ArtifactHandle } from "../../artifacts";
import type { Selector, TextMatchMode, WaitCondition } from "../../utils/ui-tree-match";
import type { FlowSelector, ScrollDirection } from "./flow-utils";

export type FlowFailureCode =
  // selector — chosen from the OBSERVATION, not the call site:
  //   matchCount === 0 → not-found;  matched but none visible → not-visible
  | "selector-not-found"
  | "selector-not-visible"
  /** A `within`/`after`/`next` scope resolved to nothing, so the target was never looked for. */
  | "selector-scope-unresolved"
  /** A gesture step carried neither a selector nor x/y coordinates. */
  | "target-missing"
  // assertion (determinate)
  | "assert-hidden-unmet"
  | "text-mismatch"
  | "text-no-match"
  // indeterminate — the tier the runner used to drop
  | "condition-never-readable"
  | "condition-hidden-unconfirmable"
  | "condition-dark-tail"
  | "when-guard-indeterminate"
  // scroll / gesture
  | "scroll-target-not-found"
  | "scroll-container-not-visible"
  | "gesture-geometry-unsatisfiable"
  | "directive-unsupported"
  // launch / environment
  | "launch-failed"
  | "tree-source-not-ready"
  | "tree-source-unavailable"
  // composition
  | "run-cyclic"
  | "run-depth-exceeded"
  | "run-fragment-load-failed"
  // snapshot
  | "snapshot-diff"
  | "snapshot-baseline-missing"
  | "snapshot-dimension-mismatch"
  | "snapshot-crop-empty"
  // tool / catch-all
  | "tool-ui-wait-unmet"
  | "tool-step-failed"
  | "directive-threw"
  | "step-kind-unsupported"
  | "unclassified";

export type FlowFailureCategory =
  | "selector"
  | "assertion"
  | "indeterminate"
  | "scroll"
  | "gesture"
  | "snapshot"
  | "launch"
  | "environment"
  | "composition"
  | "tool";

/**
 * Total map — a new {@link FlowFailureCode} without a category is a compile
 * error here, rather than a code that renders under no heading.
 */
export const FLOW_FAILURE_CATEGORY: Record<FlowFailureCode, FlowFailureCategory> = {
  "selector-not-found": "selector",
  "selector-not-visible": "selector",
  "selector-scope-unresolved": "selector",
  "target-missing": "selector",
  "assert-hidden-unmet": "assertion",
  "text-mismatch": "assertion",
  "text-no-match": "assertion",
  "condition-never-readable": "indeterminate",
  "condition-hidden-unconfirmable": "indeterminate",
  "condition-dark-tail": "indeterminate",
  "when-guard-indeterminate": "indeterminate",
  "scroll-target-not-found": "scroll",
  "scroll-container-not-visible": "scroll",
  "gesture-geometry-unsatisfiable": "gesture",
  "directive-unsupported": "gesture",
  "launch-failed": "launch",
  "tree-source-not-ready": "environment",
  "tree-source-unavailable": "environment",
  "run-cyclic": "composition",
  "run-depth-exceeded": "composition",
  "run-fragment-load-failed": "composition",
  "snapshot-diff": "snapshot",
  "snapshot-baseline-missing": "snapshot",
  "snapshot-dimension-mismatch": "snapshot",
  "snapshot-crop-empty": "snapshot",
  "tool-ui-wait-unmet": "tool",
  "tool-step-failed": "tool",
  "directive-threw": "tool",
  "step-kind-unsupported": "tool",
  "unclassified": "tool",
};

/**
 * Codes whose meaning is "argent could not see the screen", not "the check
 * failed". A CI operator reads this to decide retry-vs-fix, so it is derived
 * from the code rather than re-asserted at each production site.
 */
const INDETERMINATE_CODES: ReadonlySet<FlowFailureCode> = new Set<FlowFailureCode>([
  "condition-never-readable",
  "condition-hidden-unconfirmable",
  "condition-dark-tail",
  "when-guard-indeterminate",
  "tree-source-unavailable",
  "tree-source-not-ready",
]);

export function determinacyOf(code: FlowFailureCode): "determinate" | "indeterminate" {
  return INDETERMINATE_CODES.has(code) ? "indeterminate" : "determinate";
}

/** Flat projection of a DescribeNode — no children, no recursion, bounded fields. */
export interface FlowFailureNode {
  role: string;
  /** Normalized, rounded to 3dp — the precision `treeFingerprint` already treats as significant. */
  frame: DescribeFrame;
  label?: string;
  identifier?: string;
  value?: string;
  /** `subtreeText`, when it differs from label/value. */
  text?: string;
  /** "clickable,focused,disabled" — one string beats eight booleans on the wire. */
  flags?: string;
}

export interface FlowFailureSelector {
  /** `describeSelector(sel)` — the same spelling that appears in `message`. */
  described: string;
  /** The selector as JSON, minus the internal `loose` flag (hoisted out beside it). */
  fields: Record<string, unknown>;
  loose: boolean;
  /**
   * The strict passes the runner ACTUALLY tried. A bare-string `tap: foo`
   * yields `[{identifier:"foo"},{text:"foo"}]`. This is the answer to "what did
   * it look for", which the prose has never carried.
   */
  alternatives: Selector[];
  /** Set when a relational scope resolved to nothing — the target was never reached. */
  unresolvedScope?: "within" | "after" | "next";
}

export type FlowFailureExpectation =
  | {
      kind: "condition";
      condition: WaitCondition;
      text?: string;
      textMatch?: TextMatchMode;
      timeoutMs: number;
    }
  | { kind: "scroll"; direction: ScrollDirection; maxIterations: number; within?: string }
  | { kind: "snapshot"; snapshotKey: string; maxMismatch: number }
  | { kind: "gesture"; gesture: string; detail?: string };

/** What the runner actually observed — from `waitForCondition`'s last matches. */
export interface FlowFailureObservation {
  matchCount: number;
  visibleMatchCount: number;
  /**
   * Matched every field but had a zero-area frame. THE diagnosis for
   * `selector-not-visible` — kept out of `candidates`, which means "other
   * elements you might have meant".
   */
  invisibleMatches?: FlowFailureNode[];
  /** The element a `text` condition read. */
  element?: FlowFailureNode;
  /** `assertText(first)` — what the check compared against. */
  text?: string;
  /** `nodeText(first)`, when it differs from {@link text}. */
  ownText?: string;
  mismatchPercentage?: number;
  dimensions?: {
    expected: { width: number; height: number };
    actual: { width: number; height: number };
  };
}

/**
 * Discriminated: `available` is the only form that issues elements.
 * `unavailable` NEVER falls back to a stale tree and NEVER masks the failure's
 * own cause — a post-hoc read that succeeds must not let an operator conclude
 * the tree source was fine when the step failed precisely because it wasn't.
 */
export type FlowFailureScreen =
  | {
      state: "available";
      source: DescribeSource;
      /**
       * "at-failure" = the tree the directive itself last read (preferred).
       * "after-failure" = captured post-hoc by the runner, so the app may have
       * moved on between the failure and the read.
       */
      capturedAt: "at-failure" | "after-failure";
      ageMs: number;
      /** True total, before {@link FLOW_FAILURE_ELEMENT_LIMIT} bit. */
      elementCount: number;
      elements: FlowFailureNode[];
      truncated?: true;
      /**
       * A read error that landed AFTER this tree was captured — the dark-tail
       * case, where the directive's last TRUSTED read is the best evidence
       * available but the window went dark before the deadline. Present so a
       * stale-but-trusted tree can never read as "the tree source was fine".
       */
      readError?: string;
    }
  | {
      state: "unavailable";
      reason:
        | "never-readable"
        | "read-failed"
        | "aborted"
        | "no-artifact-store"
        | "capture-timeout"
        | "omitted-for-size";
      /** The tree-source error, verbatim. */
      detail?: string;
      hint?: string;
    };

export type FlowFailureCandidateBasis =
  | "identifier-exact"
  | "identifier-near"
  | "text-exact"
  | "text-contains"
  | "text-contained-by"
  | "text-near"
  | "text-regex"
  | "role";

export interface FlowFailureCandidate {
  node: FlowFailureNode;
  /** 0..1 */
  score: number;
  /** WHY this is a suggestion — an operator can dismiss a wrong basis at a glance. */
  basis: FlowFailureCandidateBasis;
  /** Paste-able straight into the flow file. */
  selectorYaml?: string;
  /** "zero-area frame" | "disabled" | "scrolled out of its container" */
  note?: string;
}

export interface FlowFailureTiming {
  startedAt: number;
  durationMs: number;
  /** The directive's own budget, when it had one (auto-wait / assert grace). */
  budgetMs?: number;
  attempts?: number;
  lastTrustedReadAt?: number;
  darkTailMs?: number;
}

export interface FlowStepFailure {
  version: 1;
  code: FlowFailureCode;
  category: FlowFailureCategory;
  /**
   * The tier the runner used to drop. "the check could not be evaluated" is
   * not "the check failed" — a CI operator must be able to tell them apart to
   * decide whether to retry or to fix the flow.
   */
  determinacy: "determinate" | "indeterminate";
  /** Byte-identical to `StepReport.reason`, so every existing renderer stays unchanged. */
  message: string;
  hint?: string;
  step: {
    index: number;
    ordinal: number;
    kind: string;
    flow: string;
    target?: string;
    depth?: number;
  };
  selector?: FlowFailureSelector;
  expected?: FlowFailureExpectation;
  actual?: FlowFailureObservation;
  screen: FlowFailureScreen;
  candidates: FlowFailureCandidate[];
  /** Before {@link FLOW_FAILURE_CANDIDATE_LIMIT} bit. */
  candidateCount: number;
  /** Full-res capture at the moment of failure. */
  screenshot?: ArtifactHandle;
  /** Full element dump, text/plain — never inlined as a field. */
  tree?: ArtifactHandle;
  timing: FlowFailureTiming;
  /** Underlying registry code, when a thrown FailureError caused the step failure. */
  cause?: { code: string; message: string };
  data?: Record<string, string | number | boolean>;
  overflow?: { omittedBytes: number; artifact?: ArtifactHandle };
}

// ── Internal capture types (never reach the wire) ────────────────────────

/**
 * What a directive kept from the reads it made while failing, handed up to the
 * assembler. Carries LIVE `DescribeNode`s — the assembler projects them onto
 * {@link FlowFailureNode} and deletes this before the report is pushed, so a
 * whole UI tree can never ride out on the NDJSON progress stream.
 *
 * Every field is optional: a directive that failed before it read anything
 * still produces a valid (evidence-free) failure report, and the capture path
 * is fail-soft end to end.
 */
export interface DirectiveEvidence {
  code?: FlowFailureCode;
  /** The tree the directive itself last read — preferred over a post-hoc read. */
  tree?: DescribeNode;
  source?: DescribeSource;
  /** `Date.now()` of the read {@link tree} came from. */
  readAt?: number;
  /**
   * The tree-source error, verbatim. ALWAYS wins as `screen.detail`: a
   * post-hoc read that succeeds must never let an operator conclude the tree
   * source was fine when the step failed precisely because it wasn't.
   */
  treeError?: string;
  attempts?: number;
  lastTrustedReadAt?: number;
  darkTailMs?: number;
  /** What the selector matched on the last trusted read. */
  matches?: DescribeNode[];
  selector?: FlowSelector;
  expected?: FlowFailureExpectation;
  budgetMs?: number;
  hint?: string;
  cause?: { code: string; message: string };
  observation?: Partial<FlowFailureObservation>;
}

// ── Budgets ──────────────────────────────────────────────────────────────

/** Whole serialized payload. Past this, `screen.elements` is dropped and spilled to an artifact. */
export const FLOW_FAILURE_BYTE_LIMIT = 24 * 1024;
export const FLOW_FAILURE_ELEMENT_LIMIT = 40;
export const FLOW_FAILURE_CANDIDATE_LIMIT = 5;
export const FLOW_FAILURE_FIELD_BYTE_LIMIT = 256;

/** Wall-clock ceiling for the whole capture. Paid once per run, on the failing step. */
export const FLOW_DIAGNOSTICS_BUDGET_MS = 5000;

/**
 * Truncate `value` to at most `limit` UTF-8 BYTES without splitting a
 * codepoint (or a surrogate pair). Byte-accurate rather than length-accurate
 * because a screen-wide `subtreeText` can be kilobytes of multi-byte text on
 * its own, and the payload budget is denominated in bytes. Returns the input
 * unchanged when it already fits, so the common case allocates nothing.
 */
export function truncateUtf8Field(value: string, limit = FLOW_FAILURE_FIELD_BYTE_LIMIT): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= limit) return value;
  // The ellipsis costs a byte of its own; reserve it so the result still fits.
  const room = Math.max(0, limit - 1);
  let end = room;
  // Walk back off a continuation byte (10xxxxxx) to the start of its codepoint,
  // so the slice never ends mid-sequence. At most 3 steps for valid UTF-8.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8")}…`;
}

/** Round a normalized coordinate to 3dp — the precision `treeFingerprint` treats as significant. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Flags, spelled exactly as `format-tree.ts` spells them so an operator
 * reading a failure block and a `describe` dump sees one vocabulary.
 */
function projectFlags(node: DescribeNode): string | undefined {
  const flags: string[] = [];
  if (node.clickable) flags.push("clickable");
  if (node.longClickable) flags.push("long-clickable");
  if (node.scrollable) flags.push("scrollable");
  if (node.checkable) flags.push(node.checked ? "checked" : "checkable");
  if (node.focused) flags.push("focused");
  if (node.selected) flags.push("selected");
  if (node.disabled) flags.push("disabled");
  if (node.password) flags.push("password");
  if (typeof node.scrollHidden === "number" && node.scrollHidden > 0) {
    flags.push(`scrollHidden=${node.scrollHidden}`);
  }
  return flags.length === 0 ? undefined : flags.join(",");
}

/**
 * Project a live `DescribeNode` onto the flat wire shape: children dropped,
 * unset fields omitted, every string field byte-capped, and a `password`
 * node's `value` masked outright — a flow's `{{secret:NAME}}` placeholder
 * resolves to a real credential server-side, and a failure report is exactly
 * the artifact CI uploads.
 *
 * `scrub` is applied BEFORE truncation (truncating first can leave a partial
 * secret in the output), and receives every string that reaches the wire.
 */
export function projectNode(
  node: DescribeNode,
  scrub: (text: string) => string = (t) => t
): FlowFailureNode {
  const field = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : truncateUtf8Field(scrub(value));
  const out: FlowFailureNode = {
    role: truncateUtf8Field(node.role, 64),
    frame: {
      x: round3(node.frame.x),
      y: round3(node.frame.y),
      width: round3(node.frame.width),
      height: round3(node.frame.height),
    },
  };
  const label = field(node.label);
  if (label !== undefined) out.label = label;
  const identifier = field(node.identifier);
  if (identifier !== undefined) out.identifier = identifier;
  // A password field's value is the one string that must never be projected,
  // scrubbed or not — the scrubber only knows the secrets THIS run resolved,
  // and a user-typed credential is not one of them.
  if (node.value !== undefined) {
    out.value = node.password ? "«redacted»" : field(node.value)!;
  }
  // `subtreeText` only earns a slot when it says something label/value don't.
  if (
    node.subtreeText !== undefined &&
    node.subtreeText !== [node.label, node.value].filter(Boolean).join(" ")
  ) {
    const text = field(node.subtreeText);
    if (text !== undefined && text !== "") out.text = text;
  }
  const flags = projectFlags(node);
  if (flags !== undefined) out.flags = flags;
  return out;
}

/**
 * Does this node carry enough of its own identity to be worth a line in the
 * failure block? Same rule `format-tree.ts`'s `hasContent` applies, so the
 * "47 elements" a report claims are the ones a `describe` would have shown.
 */
export function isActionableNode(node: DescribeNode): boolean {
  return Boolean(
    node.label ||
    node.value ||
    node.identifier ||
    node.clickable ||
    node.longClickable ||
    node.scrollable ||
    node.checkable ||
    (typeof node.scrollHidden === "number" && node.scrollHidden > 0)
  );
}

/**
 * A scrubber that masks every exposed `ARGENT_SECRET_*` VALUE wherever it
 * appears in report text.
 *
 * The runner itself never resolves a `{{secret:NAME}}` placeholder — that
 * happens inside the keyboard tool, the last hop before the keystrokes leave
 * for the device. But a typed credential can still come BACK on screen (an app
 * echoing it into a non-password field), and a failure report is exactly the
 * artifact CI uploads. So the scrubber is built from the complete set of values
 * that could have been typed, and runs BEFORE truncation — truncating first can
 * leave a partial secret in the output.
 *
 * Values shorter than {@link MIN_SCRUBBABLE_SECRET} are skipped: a one- or
 * two-character secret would mask half the screen and destroy the report
 * without protecting anything meaningful.
 */
const MIN_SCRUBBABLE_SECRET = 4;
const SECRET_ENV_PREFIX = "ARGENT_SECRET_";

export function createSecretScrubber(
  env: NodeJS.ProcessEnv = process.env
): (text: string) => string {
  const secrets = Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith(SECRET_ENV_PREFIX) &&
        typeof entry[1] === "string" &&
        entry[1].length >= MIN_SCRUBBABLE_SECRET
    )
    // Longest first, so a secret that contains another is masked whole rather
    // than being partially rewritten by the shorter one.
    .sort((a, b) => b[1].length - a[1].length);
  if (secrets.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [key, value] of secrets) {
      if (!out.includes(value)) continue;
      out = out.split(value).join(`«secret:${key.slice(SECRET_ENV_PREFIX.length)}»`);
    }
    return out;
  };
}

/**
 * Marks an error as originating from the flow TREE SOURCE (a `fetchFlowTree`
 * read that never succeeded within its window), so a downstream catch can
 * classify it as an environment failure rather than a broken step.
 *
 * A marker rather than a message/`error_code` pattern match: the tree helpers
 * throw a dozen different registry codes across four platforms, and a
 * string-shaped test would silently stop matching the day one is renamed —
 * turning "re-run, the device wasn't readable" into "your flow is wrong".
 */
const TREE_SOURCE_ERROR = Symbol.for("argent.flowTreeSourceError");

export function markTreeSourceError<T>(error: T): T {
  if (error instanceof Error) {
    Object.defineProperty(error, TREE_SOURCE_ERROR, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}

export function isTreeSourceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { [TREE_SOURCE_ERROR]?: boolean })[TREE_SOURCE_ERROR] === true
  );
}

/** Every node of a tree in reading order (topmost, then leftmost), root excluded. */
export function flattenForReport(root: DescribeNode): DescribeNode[] {
  const all: DescribeNode[] = [];
  const walk = (node: DescribeNode): void => {
    all.push(node);
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  all.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
  return all;
}
