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

import {
  secretSources,
  type SecretSource,
  type SecretSourceOptions,
} from "@argent/configuration-core";
import type { DescribeFrame, DescribeNode, DescribeSource } from "../describe/contract";
import { contentRolesFor, describeNodeFlags, shouldEmit } from "../describe/format-tree";
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
  | { kind: "gesture"; gesture: string };

/** What the runner actually observed — from `waitForCondition`'s last matches. */
export interface FlowFailureObservation {
  /**
   * How many elements the selector matched. OPTIONAL because not every failure
   * has a selector: a snapshot diff compares pixels, and reporting a
   * fabricated `matchCount: 0` there reads as "the selector found nothing",
   * which is a different (and wrong) diagnosis.
   */
  matchCount?: number;
  visibleMatchCount?: number;
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
      /**
       * How many ACTIONABLE elements the screen had — the population
       * {@link elements} is drawn from, before the cap. Deliberately not the
       * node total: the `tree` artifact beside it is an unfiltered dump, so
       * the two legitimately differ and this is the number a `describe` would
       * have shown.
       */
      elementCount: number;
      elements: FlowFailureNode[];
      truncated?: true;
      /**
       * Screen size the frames were normalized against, in the source's native
       * units (Android px, iOS pt). Renderers print it beside the element
       * count — `47 elements, 1080x2220` — because a normalized frame means
       * nothing without it. Absent from tree sources that do not report it.
       */
      size?: { width: number; height: number };
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
        /**
         * The flow resolved to no device at all, so there was never a screen to
         * read — a device-free run's composition failure (a cyclic `run:`, an
         * unloadable fragment) is fully explained by its code and reason.
         */
        | "no-device"
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
  | "text-regex";

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
  /**
   * Reads the runner was willing to TRUST, of {@link attempts}. The gap
   * between the two is the whole indeterminate story — "21 attempted, 14
   * trusted" says the screen was readable less than two thirds of the window,
   * which is why the verdict is "could not evaluate" rather than "false".
   */
  trustedAttempts?: number;
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
  /** Screen size {@link tree}'s frames were normalized against, when the source reports it. */
  screenSize?: { width: number; height: number };
  /** `Date.now()` of the read {@link tree} came from. */
  readAt?: number;
  /**
   * The tree-source error, verbatim. ALWAYS wins as `screen.detail`: a
   * post-hoc read that succeeds must never let an operator conclude the tree
   * source was fine when the step failed precisely because it wasn't.
   */
  treeError?: string;
  attempts?: number;
  /** Of {@link attempts}, how many produced a tree the runner trusted. */
  trustedAttempts?: number;
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
  // "…" is THREE bytes in UTF-8, not one. Reserving a single byte for it would
  // overshoot `limit` by two on every truncation — which defeats the point of
  // a byte-denominated budget. A limit too small to hold the marker plus any
  // content spends the whole budget on content instead.
  const useMarker = limit > TRUNCATION_MARKER_BYTES;
  let end = useMarker ? limit - TRUNCATION_MARKER_BYTES : limit;
  // Walk back off a continuation byte (10xxxxxx) to the start of its codepoint,
  // so the slice never ends mid-sequence. At most 3 steps for valid UTF-8.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  const head = buf.subarray(0, end).toString("utf8");
  return useMarker ? `${head}${TRUNCATION_MARKER}` : head;
}

const TRUNCATION_MARKER = "…";
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8");

/** Round a normalized coordinate to 3dp — the precision `treeFingerprint` treats as significant. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** One string beats eight booleans on the wire; the vocabulary is describe's. */
function projectFlags(node: DescribeNode): string | undefined {
  const flags = describeNodeFlags(node);
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
    // A role is a class/AX name (`AXButton`, `android.widget.TextView`), so 64
    // bytes is generous - the default field cap would let a hostile tree source
    // spend 256 bytes per element on a field nobody reads for meaning.
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
  // A password field's value must never be projected, scrubbed or not — the
  // scrubber only knows the secrets THIS run resolved, and a user-typed
  // credential is not one of them.
  //
  // `node.password` is set by the Android uiautomator parser and the Chromium
  // adapter only; iOS and Vega never set it, so on those two platforms this
  // redaction does nothing and the field's masking rests entirely on the
  // scrubber. Closing that needs the flag at the SOURCE — in those tree
  // adapters — not here.
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
 * The elements worth listing in a failure block: exactly the subset a
 * `describe` would have emitted, so the count a report states and what an
 * operator sees when they inspect the screen themselves cannot disagree.
 *
 * That means `shouldEmit`, not `hasContent`. `hasContent` is only half of
 * describe's gate; the other half is the ROLE term, which is what keeps
 * unlabeled `AXButton`/`AXStaticText`/`AXImage`/`AXTextField` nodes — the
 * icon-only controls it exists for — on screen. Counting with `hasContent`
 * alone made the report undercount every screen carrying one, against the
 * `describe` it tells the operator to compare against.
 */
export function isActionableNode(node: DescribeNode, source?: DescribeSource): boolean {
  return shouldEmit(node, contentRolesFor(source));
}

/**
 * Devices this PROCESS has typed a `{{secret:…}}` value onto, latched and never
 * cleared.
 *
 * The guard it feeds has to outlive the run that set it, because the thing it
 * protects does: a credential typed by one flow is still rendered on the device
 * when the next flow runs against it. A run-scoped latch therefore closed the
 * leak only for the flow that caused it — the very next `argent flow run` (and
 * every flow after it in a directory run, the invocation the docs call the
 * canonical CI one) captured and exported the same screen with the credential
 * legible. Keying on the DEVICE is what covers that, and it closes the
 * `tool: flow-execute` composition holes in both directions for free: a nested
 * run is a separate invocation with its own run state, but it drives the same
 * device.
 *
 * Never cleared, for the same reason the run-scoped latch was never cleared:
 * the runner cannot know when the app stops rendering the value back. That is
 * the same doctrine {@link createSecretScrubber} already applies to text —
 * mask whether or not THIS run typed it — applied to the one projection no
 * scrubber can reach. Growth is bounded by the number of devices the process
 * ever drove.
 */
const secretTypedDevices = new Set<string>();

/** Latch a device as having had a credential typed onto its screen. */
export function markDeviceTypedSecret(deviceId: string): void {
  secretTypedDevices.add(deviceId);
}

/** Whether anything this process ran has typed a credential onto `deviceId`. */
export function deviceTypedSecret(deviceId: string | undefined): boolean {
  return deviceId !== undefined && secretTypedDevices.has(deviceId);
}

/**
 * A scrubber that masks every exposed secret VALUE wherever it appears in
 * report text.
 *
 * The runner itself never resolves a `{{secret:NAME}}` placeholder — that
 * happens inside the keyboard tool, the last hop before the keystrokes leave
 * for the device. But a typed credential can still come BACK on screen (an app
 * echoing it into a non-password field), and a failure report is exactly the
 * artifact CI uploads. So the scrubber is built from the complete set of values
 * that could have been typed, and runs BEFORE truncation — truncating first can
 * leave a partial secret in the output.
 *
 * "Complete" means {@link secretSources} — the SAME four-source chain
 * `resolveSecretPlaceholders` resolves through, read the same way, with no
 * options of its own so the two cannot diverge on scope. The env prefix alone
 * is not that set: `.argent/secrets.env` (project and global) and the
 * `ARGENT_SECRET_`-prefixed keys of `.env`/`.env.local` all type onto the
 * device, and the dedicated files are the placement the unknown-secret error
 * ADVISES first — so building from `process.env` masked the one setup nobody
 * uses and missed the one the tool recommends.
 *
 * Every value every source exposes is masked, not only the first-match one a
 * lookup would return: a name shadowed later in the chain is still a credential
 * on the host, and masking a value that was never typed costs the report
 * nothing while missing one that was is the whole defect above.
 *
 * Values shorter than {@link MIN_SCRUBBABLE_SECRET} are skipped: a one- or
 * two-character secret would mask half the screen and destroy the report
 * without protecting anything meaningful.
 */
const MIN_SCRUBBABLE_SECRET = 4;

export function createSecretScrubber(options: SecretSourceOptions = {}): (text: string) => string {
  // Fail-soft like the rest of the assembler: an unreadable source chain must
  // degrade to "no mask", never take a failure report down. (`secretSources`
  // already swallows per-file errors; this covers the discovery walk itself.)
  let sources: SecretSource[];
  try {
    sources = secretSources(options);
  } catch {
    return (text) => text;
  }
  const secrets: Array<[name: string, value: string]> = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const [name, value] of source.values) {
      if (value.length < MIN_SCRUBBABLE_SECRET) continue;
      // Keyed by the PAIR: the same value under two names is masked once, while
      // one name holding different values across sources masks both.
      const key = `${name}\u0000${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      secrets.push([name, value]);
    }
  }
  if (secrets.length === 0) return (text) => text;
  // Longest first, so a secret that contains another is masked whole rather
  // than being partially rewritten by the shorter one.
  secrets.sort((a, b) => b[1].length - a[1].length);
  return (text) => {
    let out = text;
    for (const [name, value] of secrets) {
      if (!out.includes(value)) continue;
      out = out.split(value).join(`«secret:${name}»`);
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
