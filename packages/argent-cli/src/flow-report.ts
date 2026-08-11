/**
 * Pure formatting for flow run reports.
 *
 * Everything here is a `(data) => string` function: no `fs`, no `process`, no
 * clock. `flow.ts` owns every side effect (reading argv, writing the report
 * file, printing) so one set of line builders can serve the terminal failure
 * block and the JUnit reporter without either growing its own dialect.
 *
 * The other reason this file is pure: a `failure` object arrives from a
 * possibly-remote `argent link` tool-server, so it is untrusted input. It is
 * normalized ONCE, here, through {@link normalizeFailure} — clamped, truncated,
 * and coerced — and both renderers consume only the normalized form. A clamp
 * that lived in one renderer would eventually be missing from the other.
 */

import { FlagParseException } from "./flag-parser.js";
import type { FlowReport, StepReport } from "./flow.js";

// ── Wire clamps ──────────────────────────────────────────────────────────
//
// `failure` is wire data from a possibly-remote server, so every bound below
// is a display guard rather than a producer contract — the same doctrine
// `stepIndent`/`MAX_RENDER_DEPTH` document for `depth` in flow.ts. A hostile
// server must not be able to make the CLI allocate an unbounded string, drive
// `padEnd`/`repeat` with a huge count, or inject lines into the block.

/** Longest rendered wire string. Also bounds every column width below. */
const MAX_WIRE_FIELD_CHARS = 300;
/** Matches the producer's FLOW_FAILURE_CANDIDATE_LIMIT; re-applied on receipt. */
const MAX_WIRE_CANDIDATES = 5;

/**
 * Names spliced into derived paths (`.argent/flows/<name>.yaml`). Mirrors the
 * tool-server's FLOW_NAME_PATTERN — a flow name that fails it is not rendered
 * as a path at all rather than printed as a bogus location.
 */
const SAFE_FLOW_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Coerce an untrusted wire value to a single-line, bounded display string.
 * Control characters (newlines included) collapse to spaces: without that a
 * remote server could inject lines into the failure block, or into a JUnit
 * attribute. The two BMP noncharacters go the same way — they render as
 * garbage in a terminal and are illegal in XML, so a display string must not
 * carry one. Returns undefined for anything that isn't a non-empty string, so
 * every call site can use presence as the "render this slot" test.
 */
export function wireText(value: unknown, limit = MAX_WIRE_FIELD_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex -- collapsing control characters is the point
  const flat = value.replace(/[\u0000-\u001F\u007F\u2028\u2029\uFFFE\uFFFF]/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function wireFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** The step kind the failure belongs to, for slots that must not restate it. */
function stepKindOf(f: Record<string, unknown>): string | undefined {
  return isRecord(f.step) ? wireText(f.step.kind, 64) : undefined;
}

/**
 * A wire epoch that `new Date(...).toISOString()` will actually accept. Outside
 * ±8.64e15 that call throws a RangeError, which the reporter's own try/catch
 * then swallowed into a warning — so a single bad number cost CI its entire
 * JUnit file rather than one attribute.
 */
const MAX_EPOCH_MS = 8.64e15;
function wireTimestamp(value: unknown): number | undefined {
  const n = wireFinite(value);
  if (n === undefined || Math.abs(n) > MAX_EPOCH_MS) return undefined;
  return n;
}

function wireCount(value: unknown): number | undefined {
  const n = wireFinite(value);
  if (n === undefined || n < 0) return undefined;
  return Math.floor(n);
}

/**
 * Rewrite a wire artifact value to a printable path with zero fetches: a plain
 * string passes through, a handle yields its server-side hostPath (or bare
 * filename). Duck-typed rather than importing `isArtifactHandle` so this module
 * stays dependency-free — and so a renderer called directly, before
 * `resolveArtifactDisplayPaths` has run, still prints something.
 */
export function artifactPath(value: unknown): string | undefined {
  if (typeof value === "string") return wireText(value);
  if (!value || typeof value !== "object") return undefined;
  const handle = value as Record<string, unknown>;
  if (handle.__argentArtifact !== true) return undefined;
  return wireText(handle.hostPath) ?? wireText(handle.filename);
}

/**
 * Where a flow's file is, for the block header and the `argent.flowFile`
 * property.
 *
 * `resolved` is the path the CLI actually ran, and it WINS whenever the failing
 * step belongs to that flow — deriving `.argent/flows/<name>.yaml` from the
 * name instead printed a location that does not exist for the two documented
 * invocations that don't live there: an out-of-tree flow
 * (`~/shared-flows/checkout.yaml`) and every nested flow of a recursive
 * directory run (`.argent/flows/batch/two.yaml` → `.argent/flows/two.yaml`).
 *
 * A step from a NESTED flow keeps the derived guess: the caller's resolved path
 * is the ROOT flow's file, which is not where that fragment lives, and the
 * convention directory is the better of two guesses.
 */
function flowFilePath(flow: unknown, resolved?: string): string | undefined {
  const name = wireText(flow, 128);
  if (resolved !== undefined) {
    const path = wireText(resolved, 256);
    if (path !== undefined) return path;
  }
  if (!name || !SAFE_FLOW_NAME.test(name)) return undefined;
  return `.argent/flows/${name}.yaml`;
}

// ── Shared step formatting ───────────────────────────────────────────────

/**
 * "what this step did" — the kind plus its target (the tool id for `tool`
 * steps, the selector/snapshot name otherwise). Shared by the terminal step
 * line and the JUnit testcase name so a step is spelled identically in both.
 */
export function stepLabel(s: StepReport): string {
  // Clamped like every other wire string: this now feeds the failure-block
  // heading and the JUnit `name` attribute, and an unclamped `target` carrying
  // newlines and ANSI escapes could repaint the lines above it — including the
  // verdict — or blow the XML attribute to megabytes.
  const kind = wireText(s.kind, 64) ?? "step";
  const what = wireText(s.tool, 128) ?? wireText(s.target);
  return what ? `${kind} ${what}` : kind;
}

/**
 * `(3.1s)` — one decimal, always, so sub-100ms steps read as `(0.0s)` rather
 * than collapsing to a bare `(0s)` that looks like a missing measurement.
 * Negative/NaN durations (wire data) clamp to zero instead of printing junk.
 */
export function formatDuration(ms: number): string {
  const finite = wireFinite(ms);
  return `(${(Math.max(0, finite ?? 0) / 1000).toFixed(1)}s)`;
}

/** JUnit's `time` attribute: seconds at 3dp. An untimed step reports 0.000. */
function junitTime(ms: unknown): string {
  return (Math.max(0, wireFinite(ms) ?? 0) / 1000).toFixed(3);
}

// ── Normalized failure ───────────────────────────────────────────────────

export interface NormalizedNode {
  /** label, else value, else subtree text — whichever names the element. */
  text?: string;
  role?: string;
  identifier?: string;
  /** "visible" | "off-screen" | "hidden" — derived from the frame, never trusted prose. */
  visibility?: string;
  /** `at 0.50, 0.86` — the normalized centre, so an agent can tap it directly. */
  center?: string;
}

export interface NormalizedCandidate {
  score?: number;
  node: NormalizedNode;
  note?: string;
  /** WHY this is a suggestion — an operator can dismiss a wrong basis at a glance. */
  basis?: string;
  /** Paste-able straight into the flow file. The whole point of ranking. */
  selectorYaml?: string;
}

/**
 * Every slot of the failure block, pre-formatted. Presence means "render this
 * slot": the block is a slot system, not a template, and this is the only
 * place that decides which slots a given failure fills.
 */
export interface NormalizedFailure {
  code: string;
  message?: string;
  determinacy: "determinate" | "indeterminate";
  /** Set only for the launch/environment shapes, where the evidence itself failed. */
  environmental: boolean;
  hint?: string;
  selector?: string;
  expected?: string;
  actual?: string;
  /** The element that WAS there — the `hidden`-unmet shape's stand-in for candidates. */
  match?: NormalizedNode;
  candidates: NormalizedCandidate[];
  screen?: string;
  reads?: string;
  device?: string;
  screenshot?: string;
  tree?: string;
  /** `.argent/flows/<flow>.yaml`, for the block header. */
  sourceFile?: string;
}

function normalizeNode(raw: unknown): NormalizedNode | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const n = raw as Record<string, unknown>;
  const node: NormalizedNode = {};
  const text = wireText(n.label) ?? wireText(n.value) ?? wireText(n.text);
  if (text !== undefined) node.text = text;
  const role = wireText(n.role, 64);
  if (role !== undefined) node.role = role;
  const identifier = wireText(n.identifier, 128);
  if (identifier !== undefined) node.identifier = identifier;
  const frame = n.frame as Record<string, unknown> | undefined;
  const x = wireFinite(frame?.x);
  const y = wireFinite(frame?.y);
  const width = wireFinite(frame?.width);
  const height = wireFinite(frame?.height);
  if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
    const cx = x + width / 2;
    const cy = y + height / 2;
    node.center = `at ${cx.toFixed(2)}, ${cy.toFixed(2)}`;
    // Visibility is DERIVED, never taken from the wire: a zero-area frame is
    // the whole diagnosis for selector-not-visible, and a centre outside the
    // unit square is the diagnosis for "add a scroll-to step".
    node.visibility =
      width <= 0 || height <= 0
        ? "hidden"
        : cx < 0 || cx > 1 || cy < 0 || cy > 1
          ? "off-screen"
          : "visible";
  }
  return Object.keys(node).length === 0 ? undefined : node;
}

function normalizeCandidates(raw: unknown): NormalizedCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedCandidate[] = [];
  // Slice BEFORE mapping: a hostile 10 000-entry array must not be walked.
  for (const entry of raw.slice(0, MAX_WIRE_CANDIDATES)) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    const node = normalizeNode(c.node);
    if (!node) continue;
    const candidate: NormalizedCandidate = { node };
    const score = wireFinite(c.score);
    if (score !== undefined) candidate.score = Math.min(1, Math.max(0, score));
    const note = wireText(c.note, 120);
    if (note !== undefined) candidate.note = note;
    const basis = wireText(c.basis, 40);
    if (basis !== undefined) candidate.basis = basis;
    const selectorYaml = wireText(c.selectorYaml, 200);
    if (selectorYaml !== undefined) candidate.selectorYaml = selectorYaml;
    out.push(candidate);
  }
  return out;
}

function normalizeScreen(raw: unknown, indeterminate: boolean): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if (s.state === "available") {
    // Count BEFORE the clamp: the slice only bounds what could be rendered,
    // and reporting its length would tell a reader "40 elements" about any
    // larger screen whose server omitted the true count.
    const count = wireCount(s.elementCount) ?? (Array.isArray(s.elements) ? s.elements.length : 0);
    const parts = [`${count} element${count === 1 ? "" : "s"}`];
    const size = s.size as Record<string, unknown> | undefined;
    const width = wireCount(size?.width);
    const height = wireCount(size?.height);
    if (width !== undefined && height !== undefined) parts.push(`${width}x${height}`);
    let line = parts.join(", ");
    // An indeterminate failure's tree is by definition the last read argent
    // could trust, not the state at the deadline — say so, or the element list
    // reads as "this is what was on screen when the check failed".
    if (indeterminate) line += " (last trusted read)";
    else if (s.capturedAt === "after-failure") line += " (captured after the failure)";
    return line;
  }
  if (s.state === "unavailable") {
    const reason = wireText(s.reason, 64) ?? "unknown";
    const detail = wireText(s.detail);
    return `unavailable — ${reason}${detail ? `: ${detail}` : ""}`;
  }
  return undefined;
}

function normalizeExpected(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as Record<string, unknown>;
  if (e.kind === "condition") {
    const text = wireText(e.text);
    if (text !== undefined) {
      const match = wireText(e.textMatch, 32);
      return `${JSON.stringify(text)}${match ? ` (${match})` : ""}`;
    }
    return wireText(e.condition, 64);
  }
  if (e.kind === "scroll") {
    const direction = wireText(e.direction, 32) ?? "scroll";
    const within = wireText(e.within);
    const max = wireCount(e.maxIterations);
    return `scroll ${direction}${within ? ` within ${within}` : ""}${max === undefined ? "" : ` (max ${max} iterations)`}`;
  }
  if (e.kind === "snapshot") {
    const key = wireText(e.snapshotKey, 128);
    const max = wireFinite(e.maxMismatch);
    return `snapshot${key ? ` ${key}` : ""}${max === undefined ? "" : ` (max ${max}% mismatch)`}`;
  }
  if (e.kind === "gesture") {
    const gesture = wireText(e.gesture, 32);
    const detail = wireText(e.detail);
    if (!gesture) return detail;
    return `${gesture}${detail ? ` ${detail}` : ""}`;
  }
  return undefined;
}

/**
 * What the check actually read. Deliberately NOT the match counters — "0
 * matches, 0 visible" restates the message, and `candidates`/`screen` already
 * answer "what was there instead".
 */
function normalizeActual(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const text = wireText(a.text) ?? wireText(a.ownText);
  if (text !== undefined) return JSON.stringify(text);
  const mismatch = wireFinite(a.mismatchPercentage);
  if (mismatch !== undefined) return `${mismatch.toFixed(2)}% differs`;
  return undefined;
}

/**
 * The read breakdown, emitted only for the indeterminate tier — it exists to
 * answer "could argent see the screen at all?", which is the only question
 * that distinguishes "retry this" from "fix this".
 */
function normalizeReads(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  const parts: string[] = [];
  const attempts = wireCount(t.attempts);
  if (attempts !== undefined) parts.push(`${attempts} attempted`);
  const trusted = wireCount(t.trustedAttempts);
  if (trusted !== undefined) parts.push(`${trusted} trusted`);
  const dark = wireFinite(t.darkTailMs);
  if (dark !== undefined && dark > 0) {
    parts.push(`last trusted ${(dark / 1000).toFixed(1)}s before the deadline`);
  }
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * Fold an untrusted `failure` into the slots the renderers print. `fallback`
 * supplies the flow name for the derived source path when the wire object
 * carries none, and `flowFile` the path the CLI actually ran — see
 * {@link flowFilePath}.
 */
export function normalizeFailure(
  raw: unknown,
  fallback: { flow?: string; device?: string; flowFile?: string } = {}
): NormalizedFailure | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Record<string, unknown>;
  // An unknown code renders generically: it is printed verbatim (bounded) and
  // drives no behaviour, so a newer server's vocabulary degrades to prose
  // rather than to a blank line.
  const code = wireText(f.code, 64) ?? "unclassified";
  const step = (f.step ?? {}) as Record<string, unknown>;
  const category = wireText(f.category, 32);
  const indeterminate =
    f.determinacy === "indeterminate" ||
    (f.determinacy === undefined && /^(condition-|when-guard-|tree-source-)/.test(code));

  const out: NormalizedFailure = {
    code,
    determinacy: indeterminate ? "indeterminate" : "determinate",
    environmental:
      category === "launch" ||
      category === "environment" ||
      (category === undefined && /^(launch-|tree-source-)/.test(code)),
    candidates: normalizeCandidates(f.candidates),
  };

  const message = wireText(f.message);
  if (message !== undefined) out.message = message;
  const hint = wireText(f.hint);
  const screenHint = wireText((f.screen as Record<string, unknown> | undefined)?.hint);
  if ((hint ?? screenHint) !== undefined) out.hint = hint ?? screenHint;

  const selector = wireText((f.selector as Record<string, unknown> | undefined)?.described);
  if (selector !== undefined) out.selector = selector;

  // A bare gesture expectation ("tap") says nothing the block heading and the
  // step line above it have not already said twice, so it earns no slot.
  const expected = normalizeExpected(f.expected);
  if (expected !== undefined && expected !== stepKindOf(f)) out.expected = expected;
  const actual = normalizeActual(f.actual);
  if (actual !== undefined) out.actual = actual;
  // `match:` fills the candidates slot for the shapes where the element WAS
  // found (a `hidden` assertion that stayed visible). When the observation
  // already produced an `actual:` line, that line carries the reading and a
  // second row of the same element would just be noise.
  if (actual === undefined) {
    const observed = f.actual as Record<string, unknown> | undefined;
    // `invisibleMatches` is THE diagnosis for `selector-not-visible`: the
    // element the selector named IS on the tree, it just has a zero-area
    // frame. Without this it never reached any surface, so the one shape whose
    // fix is "find out why it has no size" rendered with no element at all —
    // and its candidate list is deliberately empty, because the operator did
    // not mean a different element.
    const invisible = Array.isArray(observed?.invisibleMatches)
      ? observed.invisibleMatches[0]
      : undefined;
    const match = normalizeNode(observed?.element ?? invisible);
    if (match) out.match = match;
  }

  const screen = normalizeScreen(f.screen, indeterminate);
  // The environmental shapes have no element list worth printing — but their
  // screen slot is where the producer puts the tree-read error, which is the
  // ONLY statement of why the step failed (the message is the generic
  // selector prose). Suppressing the slot wholesale deleted the cause.
  // The environmental shapes have no element list worth printing, and `device:`
  // takes the slot. The exception is a screen that carries a DETAIL: for the
  // tree-source codes that is where the producer puts the read error, and it is
  // the only statement of why the step failed — the message on that path is the
  // generic selector prose, which says nothing about the tree. Suppressing the
  // slot wholesale deleted the cause from both the terminal and the JUnit body.
  const carriesCause = isRecord(f.screen) && wireText(f.screen.detail) !== undefined;
  if (screen !== undefined && (!out.environmental || carriesCause)) out.screen = screen;
  if (indeterminate) {
    const reads = normalizeReads(f.timing);
    if (reads !== undefined) out.reads = reads;
  }

  // The launch/tree-source shapes have no screen and no tree — the evidence
  // itself is what failed. The device identity takes their place.
  if (out.environmental) {
    const platform = wireText((f.data as Record<string, unknown> | undefined)?.platform, 32);
    const device = wireText(fallback.device, 128);
    if (device !== undefined) out.device = `${device}${platform ? ` (${platform})` : ""}`;
  } else {
    const tree = artifactPath(f.tree);
    if (tree !== undefined) out.tree = tree;
  }

  const screenshot = artifactPath(f.screenshot);
  if (screenshot !== undefined) out.screenshot = screenshot;
  // No image because the run typed a credential: a full-resolution capture is
  // the one projection no scrubber reaches. Said in words, since a silently
  // absent screenshot reads as a broken capture.
  else if ((f.data as Record<string, unknown> | undefined)?.screenshotOmitted === "secret-typed") {
    out.screenshot = SECRET_SCREENSHOT_NOTE;
  }

  const source = (step.source ?? {}) as Record<string, unknown>;
  // Whether the resolved path applies is the CALLER's call, not one this
  // function can make: `fallback.flow` is `step.flow` for the very step being
  // normalized, so comparing them here was a tautology and every nested
  // fragment's failure got the ROOT flow's file. The callers know both names
  // and pass `flowFile` only for a root-flow step.
  const file =
    wireText(source.file, 256) ??
    flowFilePath(wireText(step.flow, 128) ?? fallback.flow, fallback.flowFile);
  if (file !== undefined) {
    const line = wireCount(source.line);
    out.sourceFile = line !== undefined && line > 0 ? `${file}:${line}` : file;
  }
  return out;
}

// ── Candidate table ──────────────────────────────────────────────────────

function candidateCells(c: NormalizedCandidate, withCenter: boolean): string[] {
  const cells = [
    c.score === undefined ? "" : c.score.toFixed(2),
    c.node.text === undefined ? "" : JSON.stringify(c.node.text),
    c.node.role ?? "",
    c.node.identifier === undefined ? "" : `id=${c.node.identifier}`,
    c.node.visibility ?? "",
  ];
  if (withCenter) cells.push(c.node.center ?? "");
  // The suggestion is the headline output of ranking — a selector the operator
  // pastes straight back into the flow — so it belongs on the CI surface, not
  // only on the MCP one. `basis` is deliberately NOT a column here: the MCP
  // surface carries it for the repair loop, and a terminal row already spends
  // its width on the things a human reads first.
  cells.push(c.selectorYaml === undefined ? "" : `→ ${c.selectorYaml}`);
  cells.push(c.note === undefined ? "" : `— ${c.note}`);
  return cells;
}

/**
 * Column-aligned candidate rows. Every cell is already wire-bounded, so the
 * widest column is bounded too and `padEnd` can never be handed a huge count.
 * A column that is empty for every row is dropped rather than padded, so a
 * tree with no identifiers doesn't print a ragged blank gutter.
 */
export function candidateRows(
  candidates: NormalizedCandidate[],
  opts: { withCenter?: boolean } = {}
): string[] {
  const rows = candidates.map((c) => candidateCells(c, opts.withCenter ?? false));
  if (rows.length === 0) return [];
  const columns = rows[0]!.length;
  const kept: number[] = [];
  for (let i = 0; i < columns; i++) if (rows.some((r) => r[i] !== "")) kept.push(i);
  const widths = kept.map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((row) =>
    kept
      .map((column, k) => row[column]!.padEnd(widths[k]!))
      .join("  ")
      .trimEnd()
  );
}

/** One `match:`-style row for a single element (no score column). */
export function nodeRow(node: NormalizedNode): string {
  return [
    node.text === undefined ? "" : JSON.stringify(node.text),
    node.role ?? "",
    node.identifier === undefined ? "" : `id=${node.identifier}`,
    node.visibility ?? "",
    node.center ?? "",
  ]
    .filter((cell) => cell !== "")
    .join("  ");
}

// ── Reporter specs ───────────────────────────────────────────────────────

type ReporterSpec = { format: "default" } | { format: "junit"; path: string };

/**
 * `default` | `junit:<path>`. Rejected specs throw FlagParseException so
 * `argent flow run` exits 2 before the tool call — a report the operator asked
 * for and did not get is worse than a run that never started, especially in CI
 * where the XML is the only artifact anyone reads.
 *
 * Split on the FIRST colon so a Windows path (`junit:C:\out.xml`) survives.
 */
export function parseReporterSpec(spec: string): ReporterSpec {
  const raw = typeof spec === "string" ? spec.trim() : "";
  if (raw === "") throw new FlagParseException("--reporter requires a value");
  const sep = raw.indexOf(":");
  const format = sep === -1 ? raw : raw.slice(0, sep);
  const rest = sep === -1 ? "" : raw.slice(sep + 1).trim();
  if (format === "default") {
    if (rest !== "") throw new FlagParseException("--reporter default does not take a path");
    return { format: "default" };
  }
  if (format === "junit") {
    if (rest === "")
      throw new FlagParseException("--reporter junit requires a path (junit:<path>)");
    return { format: "junit", path: rest };
  }
  throw new FlagParseException(
    `--reporter has unknown format "${format}" (expected default or junit:<path>)`
  );
}

// ── JUnit XML ────────────────────────────────────────────────────────────

/**
 * XML entity escaping, plus a strip of every character XML 1.0 forbids
 * ANYWHERE in a document — escaped or not, since no spelling makes them legal.
 * The strip is the part every hand-rolled escaper forgets: `text` reaches this
 * file straight off a device's accessibility tree, and ONE such character makes
 * the whole document unparseable, which in CI means the reporter silently
 * produces no annotations at all out of a file that exists and looks plausible.
 *
 * The `Char` production excludes two classes, and both are stripped here: the
 * C0 controls (tab/LF/CR are legal and survive) and the BMP noncharacters
 * U+FFFE/U+FFFF, which the control range alone missed — a mis-decoded UTF-16
 * BOM lands as U+FFFE exactly that way. Unpaired surrogates need no branch: the
 * UTF-8 encoder that writes the file replaces each with U+FFFD, which is legal.
 */
export function xmlEscape(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- stripping these is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

/**
 * The platform the runner actually resolved, read off the first step that
 * carries a failure. Untrusted wire data like everything else here, so it goes
 * through `wireText`; absent from a pre-`data` tool-server and from a run with
 * no failing step, where the property is simply omitted.
 */
function resolvedPlatform(report: { steps?: unknown }): string | undefined {
  const steps = Array.isArray(report.steps) ? report.steps : [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const failure = (step as { failure?: unknown }).failure;
    if (typeof failure !== "object" || failure === null) continue;
    const data = (failure as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) continue;
    const platform = wireText((data as Record<string, unknown>).platform, 32);
    if (platform !== undefined) return platform;
  }
  return undefined;
}

interface JUnitMeta {
  device?: string;
  platform?: string;
  flowFile?: string;
  hostname?: string;
  /** ISO-8601. Derived from `report.startedAt` when omitted. */
  timestamp?: string;
  /** Whole-run wall clock. Falls back to `report.durationMs`, then to the step sum. */
  durationMs?: number;
  /**
   * Why a suite with no steps failed — a flow the tool-server REJECTED before
   * it ran (bad YAML, an unknown step key) produces no report at all, and
   * "the run failed with no failing step" says nothing an operator can act on.
   * Wire data like every other message here (it is the transport error from a
   * possibly-remote server), so it goes through `wireText` before it lands in
   * an attribute.
   */
  incompleteMessage?: string;
}

function attrs(pairs: [string, string | undefined][]): string {
  return pairs
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
    .join("");
}

/**
 * The detail body of a `<failure>`/`<error>`: the same slots the terminal
 * block prints, minus the context window (a CI checks UI shows the step name
 * already) and minus column alignment (proportional fonts eat it anyway).
 */
function junitDetailLines(s: StepReport, f: NormalizedFailure | undefined): string[] {
  const lines: string[] = [];
  if (!f) {
    const reason = wireText(s.reason);
    return reason ? [reason] : [];
  }
  if (f.selector) lines.push(`selector: ${f.selector}`);
  if (f.expected) lines.push(`expected: ${f.expected}`);
  if (f.actual) lines.push(`actual: ${f.actual}`);
  if (f.match) lines.push(`match: ${nodeRow(f.match)}`);
  // One hint, never two - see the same rule in renderFailureBlock.
  if (f.hint) lines.push(`hint: ${f.hint}`);
  else if (f.determinacy === "indeterminate") lines.push(`hint: ${INDETERMINATE_HINT}`);
  if (f.candidates.length > 0) {
    lines.push("candidates:");
    for (const row of candidateRows(f.candidates)) lines.push(`  ${row}`);
  }
  if (f.screen) lines.push(`screen: ${f.screen}`);
  if (f.reads) lines.push(`reads: ${f.reads}`);
  if (f.device) lines.push(`device: ${f.device}`);
  for (const [role, value] of Object.entries(s.artifacts ?? {})) {
    const p = artifactPath(value);
    // The KEY is wire data too — clamping only the value beside it would leave
    // a server free to put escape sequences in the label.
    const label = wireText(role, 64);
    if (p && label) lines.push(`${label}: ${p}`);
  }
  // A snapshot failure's `current` IS the screenshot at the moment of failure,
  // so the three roles above already name it. The terminal block draws the same
  // suppression; without it here the body listed four paths for three images.
  const isSnapshotShot = artifactPath(s.artifacts?.current) !== undefined;
  if (f.screenshot && !isSnapshotShot) lines.push(`screenshot: ${f.screenshot}`);
  if (f.tree) lines.push(`tree: ${f.tree}`);
  return lines;
}

/** One flow's contribution to the document's `<testsuites>` counters. */
interface SuiteTotals {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  timeMs: number;
}

/** One flow of a run, with the metadata only the caller knows about it. */
export interface JUnitRun {
  report: FlowReport;
  meta?: JUnitMeta;
}

/**
 * One flow's `<testsuite>`; each step is a `<testcase>`.
 *
 * Per-failure attribution in the checks UI is the entire value of JUnit in CI,
 * and a flow is 10-50 individually-named steps — collapsing them into one
 * testcase throws that away. It is also the only mapping that can use JUnit's
 * `<failure>` vs `<error>` split, which argent already draws (`fail` = an
 * assertion said no; `error` = the machinery broke).
 *
 * `echo` steps are narration, not steps: they are excluded from the counters
 * (as the runner's own `summarize` excludes them), so emitting them as
 * testcases would make `tests=` disagree with the testcase count. Their text
 * joins the suite-level `<system-out>` instead.
 */
function junitSuite(report: FlowReport, meta: JUnitMeta): { lines: string[]; totals: SuiteTotals } {
  const flow = wireText(report.flow, 128) ?? "flow";
  const steps = Array.isArray(report.steps) ? report.steps : [];
  // Counts derive from the steps, never from the wire counters: the testcase
  // elements and the attributes summarising them cannot then disagree.
  const counted = steps.filter((s) => s.kind !== "echo");
  const failures = counted.filter((s) => s.status === "fail").length;
  const errors = counted.filter((s) => s.status === "error").length;
  const skipped = counted.filter((s) => s.status === "skip").length;
  // A cancelled run fails the verdict with every step pass/skip. Reporting it
  // as a clean suite would show green in the checks UI next to a red build.
  const incomplete = report.ok === false && failures === 0 && errors === 0;

  const stepSum = counted.reduce((sum, s) => sum + (wireFinite(s.durationMs) ?? 0), 0);
  const timeMs = Math.max(0, wireFinite(meta.durationMs ?? report.durationMs ?? stepSum) ?? 0);
  const startedAt = wireTimestamp(report.startedAt);
  const timestamp =
    meta.timestamp ?? (startedAt !== undefined ? new Date(startedAt).toISOString() : undefined);

  const totals: SuiteTotals = {
    tests: counted.length,
    failures,
    errors: errors + (incomplete ? 1 : 0),
    skipped,
    timeMs,
  };

  const out: string[] = [];
  out.push(
    `  <testsuite name="${xmlEscape(flow)}"${junitCounters(totals)}${attrs([
      ["timestamp", timestamp],
      ["hostname", meta.hostname ?? wireText(report.device, 128)],
    ])}>`
  );

  const properties: [string, string | undefined][] = [
    ["argent.device", meta.device ?? wireText(report.device, 128)],
    // `--platform` only narrows auto-detection, so it is absent on the common
    // run; the RESOLVED platform rides in on the failure instead. Preferring
    // the flag keeps an explicit choice authoritative, while the fallback is
    // what stops the property from disappearing exactly when a CI reader most
    // wants it — on a failing run nobody pinned a platform for.
    ["argent.platform", meta.platform ?? resolvedPlatform(report)],
    ["argent.flowFile", meta.flowFile ?? flowFilePath(report.flow)],
  ];
  const present = properties.filter((p): p is [string, string] => p[1] !== undefined);
  if (present.length > 0) {
    out.push("    <properties>");
    for (const [name, value] of present) {
      out.push(`      <property name="${xmlEscape(name)}" value="${xmlEscape(value)}"/>`);
    }
    out.push("    </properties>");
  }

  if (incomplete) {
    out.push(
      `    <error type="run-incomplete" message="${xmlEscape(
        wireText(meta.incompleteMessage) ??
          (report.aborted
            ? "run cancelled before it completed"
            : "the run failed with no failing step")
      )}"/>`
    );
  }

  let ordinal = 0;
  for (const s of steps) {
    if (s.kind === "echo") continue;
    ordinal++;
    const name = `${String(ordinal).padStart(2, "0")} ${stepLabel(s)}`;
    const open = `    <testcase${attrs([
      ["classname", flow],
      ["name", name],
      ["time", junitTime(s.durationMs)],
    ])}`;
    if (s.status === "pass") {
      out.push(`${open}/>`);
      continue;
    }
    out.push(`${open}>`);
    if (s.status === "skip") {
      // Post-failure skips carry no reason of their own; say why they were not
      // run rather than emitting a bare, unexplained <skipped/>.
      const reason =
        wireText(s.reason) ??
        (failures + errors > 0 ? "run stopped at the first failure" : undefined);
      out.push(`      <skipped${attrs([["message", reason]])}/>`);
    } else {
      // Same rule as the terminal block: `meta.flowFile` is the ROOT flow's
      // file, so it applies only to a step of that flow.
      const stepFlow = s.flow ?? report.flow;
      const f = normalizeFailure(s.failure, {
        flow: stepFlow,
        device: report.device,
        ...(stepFlow === report.flow ? { flowFile: meta.flowFile } : {}),
      });
      const tag = s.status === "error" ? "error" : "failure";
      const detail = junitDetailLines(s, f).join("\n");
      const head = `      <${tag}${attrs([
        ["type", f?.code ?? s.status],
        ["message", wireText(f?.message) ?? wireText(s.reason)],
      ])}`;
      if (detail === "") out.push(`${head}/>`);
      else out.push(`${head}>${xmlEscape(detail)}</${tag}>`);
      const sysout = [`status: ${s.status}`, `durationMs: ${wireFinite(s.durationMs) ?? 0}`];
      if (f) sysout.push(`code: ${f.code}`);
      out.push(`      <system-out>${xmlEscape(sysout.join("\n"))}</system-out>`);
    }
    out.push("    </testcase>");
  }

  const narration = steps
    .filter((s) => s.kind === "echo")
    .map((s) => wireText(s.message))
    .filter((m): m is string => m !== undefined);
  if (narration.length > 0) {
    out.push(`    <system-out>${xmlEscape(narration.join("\n"))}</system-out>`);
  }

  out.push("  </testsuite>");
  return { lines: out, totals };
}

function junitCounters(t: SuiteTotals): string {
  return attrs([
    ["tests", String(t.tests)],
    ["failures", String(t.failures)],
    ["errors", String(t.errors)],
    ["skipped", String(t.skipped)],
    ["time", junitTime(t.timeMs)],
  ]);
}

/**
 * The whole document: one `<testsuite>` per flow, under a `<testsuites>` whose
 * counters are their sum.
 *
 * A directory run is the canonical CI invocation (`argent flow run
 * .argent/flows -r`), and per-suite attribution is the entire point of the
 * reporter — so a run of N flows is N suites in ONE file, not one file that
 * only the single-flow path ever wrote.
 */
export function buildJUnitDocument(runs: JUnitRun[]): string {
  const suites = runs.map(({ report, meta }) => junitSuite(report, meta ?? {}));
  const totals = suites.reduce<SuiteTotals>(
    (sum, s) => ({
      tests: sum.tests + s.totals.tests,
      failures: sum.failures + s.totals.failures,
      errors: sum.errors + s.totals.errors,
      skipped: sum.skipped + s.totals.skipped,
      timeMs: sum.timeMs + s.totals.timeMs,
    }),
    { tests: 0, failures: 0, errors: 0, skipped: 0, timeMs: 0 }
  );

  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  out.push(`<testsuites name="argent flow"${junitCounters(totals)}>`);
  for (const suite of suites) out.push(...suite.lines);
  out.push("</testsuites>");
  return `${out.join("\n")}\n`;
}

/** One flow's report as a whole document — the single-flow `flow run` path. */
export function buildJUnitXml(report: FlowReport, meta: JUnitMeta = {}): string {
  return buildJUnitDocument([{ report, meta }]);
}

/**
 * The sentence an indeterminate failure exists to deliver. "the check could
 * not be evaluated" is not "the check failed" — an operator reading a CI log
 * has to be able to tell them apart to choose between re-running and editing
 * the flow, and every other signal (glyph, counters, exit code) is identical.
 */
export const INDETERMINATE_HINT =
  "not a failed assertion — argent could not read the screen; re-run or fix the device/tree source rather than editing the flow";

/**
 * Stands in for the `screenshot:` path when the run typed a `{{secret:…}}`
 * value. Pixels are never scrubbed, so the capture is declined outright — and
 * saying so is what stops a reader (or an agent) from taking the shot itself.
 */
const SECRET_SCREENSHOT_NOTE =
  "(omitted — this run typed a secret, and a capture of this screen could reveal it)";
