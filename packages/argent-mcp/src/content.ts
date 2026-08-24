/**
 * Convert raw tool results into MCP content blocks (text / image).
 *
 * Extracted so it can be tested independently of the MCP server wiring.
 */

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  materializeArtifacts,
  isArtifactHandle,
  type MaterializeContext,
} from "@argent/tools-client";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Context for resolving artifact handles in a result. When omitted, content
 * rendering falls back to the legacy `{ url, path }` screenshot shape (used by
 * older tool-servers and by unit tests that don't exercise the artifact path).
 */
export type ContentContext = MaterializeContext;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageBlock(data: Buffer, mimeType: string): ContentBlock {
  return { type: "image", data: data.toString("base64"), mimeType };
}

// Fetch image bytes and confirm they actually start with a PNG signature.
// Without this check, a 404 (file missing), an HTML error page, or any other
// non-PNG response would be base64'd and labelled `image/png`, which the
// model API rejects with "Image could not be processed" (issue #255).
//
// `file://` URLs are handled directly via the fs module — Node's built-in
// `fetch` only supports `http(s)://`, and the ios-remote screenshot path
// writes PNGs to a temp dir and returns a `file://` URL.
async function fetchPngBytes(url: string): Promise<Buffer | null> {
  try {
    let buf: Buffer;
    if (url.startsWith("file://")) {
      const { readFile } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      buf = await readFile(fileURLToPath(url));
    } else {
      const res = await fetch(url);
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
    }
    if (buf.length < PNG_SIGNATURE.length) return null;
    if (!buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
    return buf;
  } catch {
    return null;
  }
}

export async function toMcpContent(
  result: unknown,
  outputHint?: string,
  ctx?: ContentContext,
  args?: unknown
): Promise<ContentBlock[]> {
  // `includeImageInContext: false` asks for the saved-path text only — no inline image.
  const suppressImage = isRecord(args) && args.includeImageInContext === false;

  // Artifact path: when a context is available, resolve handles to local files.
  // Tools producing files (screenshots, profiler exports) return artifact
  // handles instead of host paths, so this works regardless of where the
  // tool-server runs.
  if (ctx) {
    const { result: rewritten, images } = await materializeArtifacts(result, ctx);

    if (outputHint === "image") {
      if (images.length > 0) {
        const saved: ContentBlock = { type: "text", text: `Saved: ${images[0]!.localPath}` };
        if (suppressImage) return [saved];
        const blocks: ContentBlock[] = images.map((img) => imageBlock(img.data, img.mimeType));
        blocks.push(saved);
        return blocks;
      }
      // No image artifact present — fall back to the legacy `{ url, path }`
      // shape for older tool-servers.
      return legacyImageContent(rewritten, suppressImage);
    }

    const blocks: ContentBlock[] = [{ type: "text", text: stringifyForText(rewritten) }];
    // Surface any images that rode along on a non-image result.
    if (!suppressImage) for (const img of images) blocks.push(imageBlock(img.data, img.mimeType));
    return blocks;
  }

  if (outputHint === "image") {
    return legacyImageContent(result, suppressImage);
  }

  return [{ type: "text" as const, text: stringifyForText(result) }];
}

/**
 * JSON.stringify(undefined) returns undefined, which would produce an invalid
 * MCP content block ({ type: "text", text: undefined }). Coerce to "null" so a
 * result with no value still serializes to a valid text block.
 */
function stringifyForText(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/**
 * Legacy screenshot rendering for older tool-servers that return `{ url, path }`
 * instead of an artifact handle: fetch the media URL directly, validating it is
 * a real PNG (issue #255) before shipping it as an image.
 */
async function legacyImageContent(
  result: unknown,
  suppressImage: boolean
): Promise<ContentBlock[]> {
  if (result && typeof result === "object" && "url" in result) {
    const r = result as { url: string; path?: string };
    if (suppressImage) {
      return [{ type: "text" as const, text: `Saved: ${r.path ?? ""}` }];
    }
    const buf = await fetchPngBytes(r.url);
    if (buf) {
      return [imageBlock(buf, "image/png"), { type: "text", text: `Saved: ${r.path ?? ""}` }];
    }
    return [
      {
        type: "text" as const,
        text: `(Screenshot unavailable: no valid PNG at ${r.url}. Take a new screenshot.)`,
      },
    ];
  }
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// ── screenshot-diff adapter ──────────────────────────────────────────

/**
 * `diffPath` / `contextDiffPath` are artifact handles on current tool-servers
 * and raw host-path strings on older ones; both shapes render here.
 */
export interface ScreenshotDiffResult {
  summary: string;
  diffPath?: unknown;
  contextDiffPath?: unknown;
}

export function isScreenshotDiffResult(value: unknown): value is ScreenshotDiffResult {
  if (!isRecord(value)) return false;
  return typeof value.summary === "string";
}

// Render a screenshot-diff tool result as MCP content blocks: the downscaled
// context-diff image inline, then the textual summary.
export async function screenshotDiffToMcpContent(
  result: ScreenshotDiffResult,
  ctx?: ContentContext
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  // Resolve artifact handles to local files first; the context diff's bytes
  // come back in `images` whether the file was already on this machine or was
  // downloaded from a remote tool-server.
  let contextDiffPath = result.contextDiffPath;
  let materializedImages: { localPath: string; data: Buffer; mimeType: string }[] = [];
  if (ctx) {
    const { result: rewritten, images } = await materializeArtifacts(result, ctx);
    contextDiffPath = (rewritten as ScreenshotDiffResult).contextDiffPath;
    materializedImages = images;
  }

  if (typeof contextDiffPath === "string") {
    const fromMaterializer = materializedImages.find((img) => img.localPath === contextDiffPath);
    if (fromMaterializer) {
      blocks.push({
        type: "image" as const,
        data: fromMaterializer.data.toString("base64"),
        mimeType: fromMaterializer.mimeType,
      });
    } else {
      // Legacy tool-server: a raw host path the materializer passed through.
      // Only readable when co-located — exactly the old behavior.
      try {
        const buf = await readFile(contextDiffPath);
        blocks.push({
          type: "image" as const,
          data: buf.toString("base64"),
          mimeType: "image/png" as const,
        });
      } catch {
        // Image unavailable; the summary below still renders.
      }
    }
  }

  blocks.push({ type: "text" as const, text: result.summary });
  return blocks;
}

// ── flow-execute adapter ─────────────────────────────────────────────

/**
 * Narrow local copies of the tool-server's `FlowStepFailure` wire shape — only
 * the fields this renderer reads.
 *
 * Deliberately NOT imported from the tool-server: no shared package spans the
 * two (`StepReport` is already declared once per package for the same reason),
 * and every field below is untrusted wire data from a possibly-remote
 * `argent link` server, re-validated at render time by `wireText`/`wireNumber`
 * exactly as `stepIndent` already validates `depth`. Declaring the fields as
 * their intended types keeps the renderer readable; the validators are what
 * make it safe.
 */
type FlowFailureNode = {
  role?: string;
  /** Normalized (0..1) frame; its centre is what an agent can tap to verify. */
  frame?: { x?: number; y?: number; width?: number; height?: number };
  label?: string;
  identifier?: string;
  value?: string;
  text?: string;
  flags?: string;
};

type FlowFailureCandidate = {
  node?: FlowFailureNode;
  /** 0..1 */
  score?: number;
  /** Why this element is a suggestion: "identifier-near", "text-exact", … */
  basis?: string;
  /** Paste-able straight into the flow file. */
  selectorYaml?: string;
  note?: string;
};

/**
 * The producer's discriminated union flattened into one optional bag: `state`
 * is untrusted, so the renderer branches on its value and reads only the fields
 * that arm defines. `elements` is deliberately absent — the element list is
 * NEVER inlined here (see `failureBlocks`), only its count and the path to the
 * full dump.
 */
type FlowFailureScreen = {
  state?: string;
  source?: string;
  capturedAt?: string;
  elementCount?: number;
  /**
   * Screen size the frames were normalized against, in the tree source's
   * native units. Absent from a source (or a tool-server) that does not
   * report it, so every use is presence-gated.
   */
  size?: { width?: number; height?: number };
  truncated?: boolean;
  reason?: string;
  detail?: string;
  hint?: string;
};

export type FlowStepFailure = {
  code?: string;
  category?: string;
  determinacy?: string;
  /** Byte-identical to `FlowStepResult.reason` on a current tool-server. */
  message?: string;
  hint?: string;
  expected?: {
    kind?: string;
    condition?: string;
    text?: string;
    textMatch?: string;
    timeoutMs?: number;
    direction?: string;
    within?: string;
    maxIterations?: number;
    snapshotKey?: string;
    maxMismatch?: number;
    gesture?: string;
  };
  actual?: {
    text?: string;
    ownText?: string;
    matchCount?: number;
    visibleMatchCount?: number;
    /** The element a `text` condition read. */
    element?: FlowFailureNode;
    /**
     * Matched every field but had a zero-area frame — THE diagnosis for
     * `selector-not-visible`, and deliberately kept out of `candidates`, which
     * answers a different question.
     */
    invisibleMatches?: FlowFailureNode[];
  };
  screen?: FlowFailureScreen;
  candidates?: FlowFailureCandidate[];
  /** True total, before the producer's own cap. */
  candidateCount?: number;
  /** Artifact handle (current tool-servers) or a raw host path (older ones). */
  screenshot?: unknown;
  /** Full element dump, text/plain — rendered as a path, never inlined. */
  tree?: unknown;
  cause?: { code?: string; message?: string };
  /** Free-form run context: `platform`, and why a screenshot is absent. */
  data?: Record<string, unknown>;
};

export type FlowStepResult = {
  index?: number;
  kind: string;
  status?: "pass" | "fail" | "skip" | "error";
  reason?: string;
  /**
   * A step that passed in a way that weakens it as proof — raised today by
   * `await: { idle: true }`, which never fails a run and says here what its
   * green actually bought (see StepReport.warning in the tool-server's
   * flow-run). Also carries the caveat older tool-servers put on a snapshot
   * that adopted a missing baseline, which now fails the step instead. Live
   * either way: dropping the field would silently delete the only thing the
   * readiness check reports.
   */
  warning?: string;
  tool?: string;
  message?: string;
  result?: unknown;
  outputHint?: string;
  args?: unknown;
  flow?: string;
  /** Human-readable step target (selector / snapshot name), set by the runner. */
  target?: string;
  /**
   * Nesting depth: absent/0 at top level, +1 inside each nesting step
   * (`when:` guarded steps, `run:` fragment steps). The label is indented by
   * it; a pre-depth tool-server sends none and the report renders flat.
   */
  depth?: number;
  /**
   * Snapshot-step artifacts keyed by role (baseline/current/diff). Values are
   * artifact handles on current tool-servers; treated as untrusted wire data
   * here, so anything else renders as text or is skipped.
   */
  artifacts?: Record<string, unknown>;
  /**
   * Structured diagnosis for a step that did not pass: what was looked for,
   * what was on screen, the closest matching elements, and handles to evidence
   * captured at the moment of failure. Absent on older tool-servers, so every
   * renderer below is gated on presence and falls back to `reason` alone.
   */
  failure?: FlowStepFailure;
  /** Step wall-clock. Absent on older tool-servers (and on skipped steps). */
  durationMs?: number;
  /** Legacy field from pre-report flow-execute results. */
  error?: string;
};

export type FlowExecuteResult = {
  flow: string;
  device?: string;
  executionPrerequisite?: string;
  ok?: boolean;
  passed?: number;
  failed?: number;
  skipped?: number;
  errored?: number;
  steps: FlowStepResult[];
};

const STATUS_GLYPH: Record<string, string> = {
  pass: "✓",
  fail: "✗",
  error: "✗",
  skip: "·",
};

/**
 * Display cap on the nesting indent — not a producer bound. The tool-server's
 * run-chain and per-file when-nesting limits accumulate, so legitimate depth
 * can exceed this; such steps keep the maximum indent rather than flattening.
 * Depth is also untrusted wire data, so the clamp doubles as a guard: a buggy
 * or malicious server must not drive `repeat()` with a huge (multi-GB string)
 * or negative (throwing) count.
 */
const MAX_RENDER_DEPTH = 20;

/** Indentation for a step's nesting depth; absent/invalid depth renders flat. */
function stepIndent(depth: unknown): string {
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth <= 0) return "";
  return "  ".repeat(Math.min(depth, MAX_RENDER_DEPTH));
}

/**
 * Display caps for the failure block — the same clamp doctrine `stepIndent`
 * documents, applied to the rest of the failure payload. The producer already
 * caps these; a report from a *remote* tool-server is not bound by that, so the
 * renderer clamps again rather than trusting the count it was handed.
 */
const MAX_RENDER_CANDIDATES = 5;
/**
 * An honest tool-server sends at most one failure per run (the runner
 * hard-stops at the first non-passing leaf), so this bounds only a buggy or
 * hostile one — where an unbounded loop over individually-clamped blocks still
 * adds up to a tool result no client can hold.
 */
const MAX_RENDER_FAILURES = 10;
const MAX_RENDER_TEXT = 300;

/**
 * Wire string → renderable line fragment: non-strings and empty strings are
 * dropped, embedded newlines/tabs (which would break the block's indentation)
 * collapse to spaces, and the result is truncated. Truncation is by UTF-16
 * length rather than bytes — this is a display cap, not the producer's byte
 * budget.
 */
function wireText(value: unknown, limit = MAX_RENDER_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  // Control characters collapse along with whitespace: `\s` alone leaves ESC,
  // NUL and backspace intact, and this text is printed by a client TUI, so a
  // hostile tool-server could move the cursor and repaint lines it does not own.
  // eslint-disable-next-line no-control-regex -- collapsing control characters is the point
  const flat = value.replace(/[\s\u0000-\u001F\u007F\u2028\u2029]+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

/** Wire number → finite number, or undefined. Rejects NaN/Infinity/non-numbers. */
function wireNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A file's path WITHOUT pulling its bytes — an artifact handle prints its
 * tool-server path (or bare filename), a legacy raw path prints as-is. The same
 * economy `stepArtifactBlocks` applies to `baseline`/`current`.
 */
function artifactPath(value: unknown): string | undefined {
  if (isArtifactHandle(value)) return wireText(value.hostPath ?? value.filename);
  return wireText(value);
}

/** `(5.0s)` when the tool-server sent a duration; nothing when it didn't. */
function stepDuration(durationMs: unknown): string {
  const ms = wireNumber(durationMs);
  if (ms === undefined || ms < 0) return "";
  return ` (${(ms / 1000).toFixed(1)}s)`;
}

/**
 * Normalized centre of a candidate's frame — `x + width/2, y + height/2`, the
 * exact coordinates `gesture-tap` takes. This is what lets an agent verify a
 * suggestion by tapping it instead of re-deriving it from a `describe` dump.
 */
function frameCentre(frame: unknown): string | undefined {
  const box = wireFrame(frame);
  if (box === undefined) return undefined;
  return `${(box.x + box.width / 2).toFixed(2)}, ${(box.y + box.height / 2).toFixed(2)}`;
}

/**
 * All four frame fields or nothing.
 *
 * Defaulting a missing width/height to 0 printed a confident tap centre for a
 * frame the server never fully described — and the CLI requires all four before
 * printing one, so the two surfaces disagreed about the same element.
 */
function wireFrame(
  frame: unknown
): { x: number; y: number; width: number; height: number } | undefined {
  if (!isRecord(frame)) return undefined;
  const x = wireNumber(frame.x);
  const y = wireNumber(frame.y);
  const width = wireNumber(frame.width);
  const height = wireNumber(frame.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

/**
 * "visible" | "off-screen" | "hidden", DERIVED from the frame rather than taken
 * from the wire — the same three states the CLI derives, by the same test.
 *
 * A zero-area frame is the whole diagnosis for `selector-not-visible`, and
 * `invisibleMatches[0]` is what feeds the `match:` slot — so the one shape
 * whose entire fix is "find out why it has no size" was the shape that reached
 * the agent with no marker at all, beside a tap centre implying it could be
 * tapped.
 */
function frameVisibility(frame: unknown): string | undefined {
  const box = wireFrame(frame);
  if (box === undefined) return undefined;
  if (box.width <= 0 || box.height <= 0) return "hidden";
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return cx < 0 || cx > 1 || cy < 0 || cy > 1 ? "off-screen" : "visible";
}

/**
 * The check the step was making, for every arm the producer emits — not just
 * `condition` + `text`. Gating the slot on `expected.text` alone meant the
 * `scroll`, `snapshot`, `gesture` and text-less `condition` shapes rendered
 * nothing, so `condition: "visible"`, `timeoutMs` and `maxMismatch` never
 * reached the agent at all. Mirrors the CLI's `normalizeExpected`.
 */
function expectedLine(expected: unknown): string | undefined {
  if (!isRecord(expected)) return undefined;
  if (expected.kind === "condition") {
    const text = wireText(expected.text);
    if (text !== undefined) {
      const mode = wireText(expected.textMatch, 20);
      return `${JSON.stringify(text)}${mode ? ` (${mode})` : ""}`;
    }
    return wireText(expected.condition, 64);
  }
  if (expected.kind === "scroll") {
    const direction = wireText(expected.direction, 32) ?? "scroll";
    const within = wireText(expected.within);
    const max = wireNumber(expected.maxIterations);
    return (
      `scroll ${direction}${within ? ` within ${within}` : ""}` +
      `${max === undefined ? "" : ` (max ${Math.round(max)} iterations)`}`
    );
  }
  if (expected.kind === "snapshot") {
    const key = wireText(expected.snapshotKey, 128);
    const max = wireNumber(expected.maxMismatch);
    return `snapshot${key ? ` ${key}` : ""}${max === undefined ? "" : ` (max ${max}% mismatch)`}`;
  }
  if (expected.kind === "gesture") return wireText(expected.gesture, 32);
  return undefined;
}

/**
 * One element, spelled like a candidate row minus the score. Used for the
 * `match:` slot — the element that WAS found, on the shapes where "which
 * element did you mean instead" has no answer.
 */
function nodeLine(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  const parts: string[] = [];
  const name = wireText(node.label, 60) ?? wireText(node.value, 60) ?? wireText(node.text, 60);
  if (name) parts.push(`"${name}"`);
  const role = wireText(node.role, 40);
  if (role) parts.push(role);
  const identifier = wireText(node.identifier, 60);
  if (identifier) parts.push(`id=${identifier}`);
  const visibility = frameVisibility(node.frame);
  if (visibility) parts.push(visibility);
  const centre = frameCentre(node.frame);
  if (centre) parts.push(`at ${centre}`);
  return parts.length === 0 ? undefined : parts.join("  ");
}

/** One ~60-char candidate line: score, what it is, where to tap, paste-able YAML. */
function candidateLine(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return undefined;
  const node = isRecord(candidate.node) ? candidate.node : {};
  const score = wireNumber(candidate.score);
  const parts: string[] = [score === undefined ? "?" : score.toFixed(2)];
  const name = wireText(node.label, 60) ?? wireText(node.value, 60) ?? wireText(node.text, 60);
  if (name) parts.push(`"${name}"`);
  const role = wireText(node.role, 40);
  if (role) parts.push(role);
  const identifier = wireText(node.identifier, 60);
  if (identifier) parts.push(`id=${identifier}`);
  const visibility = frameVisibility(node.frame);
  if (visibility) parts.push(visibility);
  const centre = frameCentre(node.frame);
  if (centre) parts.push(`at ${centre}`);
  const meta = [wireText(candidate.basis, 40), wireText(candidate.note, 60)]
    .filter((v): v is string => v !== undefined)
    .join(", ");
  if (meta) parts.push(`(${meta})`);
  const yaml = wireText(candidate.selectorYaml, 120);
  if (yaml) parts.push(`→ ${yaml}`);
  return parts.join("  ");
}

/**
 * One inlined image per run, shared by the snapshot-diff renderer and the
 * failure block. Passing it through rather than deciding per step is what makes
 * the budget a RUN budget: a flow that fails five snapshot steps used to inline
 * five full diffs.
 */
type ImageBudget = { used: boolean };

type PendingFailure = { num: number; step: FlowStepResult; failure: FlowStepFailure };

/**
 * What goes in the `screenshot:` slot when the producer declined the capture,
 * keyed by its `data.screenshotOmitted`. Each ends with what the agent should
 * do INSTEAD — the failure mode this replaces is an agent reading a missing
 * image as an oversight and calling `screenshot` itself.
 */
const SCREENSHOT_OMISSION_NOTE: Record<string, string> = {
  "secret-typed":
    "omitted — a {{secret:…}} value was typed onto this device and a capture of this screen could reveal it. Do NOT call `screenshot` here; read the `tree` file below, whose text is masked.",
  "no-screen":
    "omitted — this step failed before it reached the device (a launch that never started, or a flow-composition error), so no screen belongs to it. A `screenshot` here would show an unrelated app; fix the flow file instead.",
};

/**
 * The `Failures:` section: the structured diagnosis for every step that carried
 * one, rendered under three context-economy rules.
 *
 * 1. **Exactly one inlined image per run** — the first failure's evidence (the
 *    annotated snapshot `diff`, already inlined by `stepArtifactBlocks` when
 *    the failure was a snapshot; `failure.screenshot` otherwise). Later
 *    failures get paths and a trailing pointer at the evidence directory.
 * 2. **Candidates are the payload.** Top 5, with normalized tap centres, so a
 *    repair can be verified with one `gesture-tap` instead of a fresh
 *    `describe`.
 * 3. **The screen stays a path.** `screen:` carries the element COUNT; the
 *    element list itself is never inlined — a 47-element tree costs thousands
 *    of tokens on every failure, and it is one `Read` away via `tree:`.
 */
async function failureBlocks(
  failures: PendingFailure[],
  budget: ImageBudget,
  ctx?: ContentContext
): Promise<ContentBlock[]> {
  if (failures.length === 0) return [];
  // An honest server sends exactly one (the runner hard-stops at the first
  // non-passing leaf), so this only ever bites a buggy or hostile one — where
  // an unbounded loop over budget-respecting blocks is a half-gigabyte tool
  // result. Same doctrine as MAX_RENDER_CANDIDATES / MAX_RENDER_DEPTH.
  const shown = failures.slice(0, MAX_RENDER_FAILURES);

  const blocks: ContentBlock[] = [{ type: "text", text: "Failures:" }];
  let evidenceDir: string | undefined;

  for (let i = 0; i < shown.length; i++) {
    const { num, step, failure } = failures[i]!;
    const lines: string[] = [`  ${num}) ${stepLabel(step)}${stepDuration(step.durationMs)}`];

    // An unknown code renders exactly like a known one — the renderer never
    // switches on the value, so a code this build has never heard of still
    // reaches the agent verbatim.
    const code = wireText(failure.code, 80) ?? "unclassified";
    const message = wireText(failure.message) ?? wireText(step.reason);
    lines.push(`     ${code}${message ? `: ${message}` : ""}`);

    if (failure.determinacy === "indeterminate") {
      lines.push(
        "     indeterminate: argent could not see the screen — this is NOT a failed assertion. Re-run or fix the environment; do not edit the flow."
      );
    }

    // A bare gesture expectation ("tap") says nothing the step line above has
    // not already said, so it earns no slot — the CLI draws the same rule.
    const expected = expectedLine(failure.expected);
    if (expected !== undefined && expected !== wireText(step.kind, 64)) {
      lines.push(`     expected: ${expected}`);
    }
    const actual = isRecord(failure.actual) ? failure.actual : undefined;
    const actualText = wireText(actual?.text) ?? wireText(actual?.ownText);
    if (actualText) lines.push(`     actual: "${actualText}"`);
    else {
      // `invisibleMatches` IS the diagnosis for `selector-not-visible`: the
      // element the selector named is on the tree, it just has a zero-area
      // frame. Without it the one shape whose fix is "find out why it has no
      // size" reached the agent with no element at all — and its candidate
      // list is deliberately empty, because no other element was meant.
      const invisible = Array.isArray(actual?.invisibleMatches)
        ? actual.invisibleMatches[0]
        : undefined;
      const match = nodeLine(actual?.element ?? invisible);
      if (match) lines.push(`     match: ${match}`);
    }

    const candidates = Array.isArray(failure.candidates)
      ? failure.candidates.slice(0, MAX_RENDER_CANDIDATES)
      : [];
    const candidateLines = candidates
      .map(candidateLine)
      .filter((line): line is string => line !== undefined);
    if (candidateLines.length > 0) {
      const total = wireNumber(failure.candidateCount);
      const shown =
        total !== undefined && total > candidateLines.length
          ? `${candidateLines.length} of ${Math.round(total)}`
          : `${candidateLines.length}`;
      lines.push(
        `     candidates (${shown}, ranked; "at" is the normalized tap centre — verify by tapping it):`
      );
      for (const line of candidateLines) lines.push(`       ${line}`);
    }

    const screen = isRecord(failure.screen) ? failure.screen : undefined;
    if (screen?.state === "available") {
      const count = wireNumber(screen.elementCount);
      const bits: string[] = [];
      if (count !== undefined) bits.push(`${Math.max(0, Math.round(count))} elements`);
      // Every frame in the report is normalized, so the size they were
      // normalized against is what makes a candidate's tap centre meaningful
      // to a reader comparing it against a screenshot. Absent from a
      // tree source (or a tool-server) that does not report it.
      const size = isRecord(screen.size) ? screen.size : undefined;
      const w = wireNumber(size?.width);
      const h = wireNumber(size?.height);
      if (w !== undefined && h !== undefined && w > 0 && h > 0) {
        bits.push(`${Math.round(w)}x${Math.round(h)}`);
      }
      if (screen.capturedAt === "after-failure") {
        bits.push("captured AFTER the failure — the app may have moved on");
      } else if (screen.capturedAt === "at-failure") {
        bits.push("captured at the failure");
      }
      const source = wireText(screen.source, 40);
      if (source) bits.push(`via ${source}`);
      if (bits.length > 0) lines.push(`     screen: ${bits.join(", ")}`);
    } else if (screen?.state === "unavailable") {
      const reason = wireText(screen.reason, 60) ?? "unknown";
      const detail = wireText(screen.detail);
      const hint = wireText(screen.hint);
      lines.push(
        `     screen: unavailable (${reason})${detail ? ` — ${detail}` : ""}${hint ? ` [${hint}]` : ""}`
      );
    }

    const hint = wireText(failure.hint);
    if (hint) lines.push(`     hint: ${hint}`);

    const cause = isRecord(failure.cause) ? failure.cause : undefined;
    const causeCode = wireText(cause?.code, 80);
    if (causeCode) {
      const causeMessage = wireText(cause?.message);
      lines.push(`     cause: ${causeCode}${causeMessage ? `: ${causeMessage}` : ""}`);
    }

    // Evidence. Only the FIRST failure's screenshot is materialized — for every
    // other one the handle prints its path, with no download and no image.
    //
    // A snapshot failure is skipped entirely: its `screenshot` is the SAME
    // stored artifact as the step's `current` (the producer reuses the handle
    // rather than capturing a second time, which would show a different
    // screen), and `stepArtifactBlocks` has already printed it and inlined it.
    // Rendering it again listed one image under two different path strings and
    // spent the run's single inlined image on a picture already on screen.
    const ownedByStep = isRecord(step.artifacts) && step.artifacts.current !== undefined;
    let inlineImage: ContentBlock | undefined;
    let screenshotPath: string | undefined;
    if (ownedByStep) {
      screenshotPath = undefined;
    } else if (ctx && !budget.used && isArtifactHandle(failure.screenshot)) {
      const { result: local, images } = await materializeArtifacts(failure.screenshot, ctx);
      // A null means the handle couldn't be fetched; say so rather than
      // rendering a dangling reference (the `stepArtifactBlocks` convention).
      screenshotPath = typeof local === "string" ? local : "(unavailable)";
      const img = images.find((im) => im.localPath === local);
      if (img) {
        inlineImage = imageBlock(img.data, img.mimeType);
        budget.used = true;
      }
    } else {
      screenshotPath = artifactPath(failure.screenshot);
    }
    if (screenshotPath) lines.push(`     screenshot: ${screenshotPath}`);
    // No image, and the producer said why. Both reasons carry an instruction,
    // because an agent that just sees a missing screenshot calls `screenshot`
    // itself — which is the leak the first omission prevents, and a picture of
    // an unrelated app in the second. An unknown reason renders no line, so a
    // newer server's vocabulary degrades to silence rather than a wrong claim.
    else {
      const omitted = isRecord(failure.data)
        ? wireText(failure.data.screenshotOmitted, 32)
        : undefined;
      const note = omitted === undefined ? undefined : SCREENSHOT_OMISSION_NOTE[omitted];
      if (note) lines.push(`     screenshot: ${note}`);
    }

    const treePath = artifactPath(failure.tree);
    if (treePath) {
      lines.push(`     tree: ${treePath} (read this file for the full element list)`);
    }

    if (i > 0 && evidenceDir === undefined) {
      const anyPath = treePath ?? screenshotPath;
      // A handle with no `hostPath` renders as a bare filename, whose dirname
      // is "." — useless as a pointer, so fall through to the generic wording.
      const dir = anyPath && anyPath !== "(unavailable)" ? dirname(anyPath) : ".";
      if (dir !== ".") evidenceDir = dir;
    }

    blocks.push({ type: "text", text: lines.join("\n") });
    if (inlineImage) blocks.push(inlineImage);
  }

  const more = failures.length - 1;
  if (more > 0) {
    const noun = more === 1 ? "failure" : "failures";
    blocks.push({
      type: "text",
      text: `  (${more} more ${noun} — evidence at ${evidenceDir ?? "the paths listed above"})`,
    });
  }
  return blocks;
}

function stepLabel(step: FlowStepResult): string {
  // Every part is wire data, so each goes through the same clamp the rest of
  // the block uses. Without it a `target` carrying newlines and ANSI escapes
  // rendered raw into the failure heading, where it could repaint the lines
  // above it — including the verdict.
  const kind = wireText(step.kind, 64) ?? "step";
  if (step.kind === "echo") return wireText(step.message) ?? "";
  const tool = wireText(step.tool, 128);
  if (tool) return tool;
  // A run step's target is the as-written path — `run ios/login.yaml` and
  // `run android/login.yaml` must render distinctly, not as one stem.
  const target = wireText(step.target);
  if (target) return `${kind} ${target}`;
  // Legacy: a pre-target tool-server sends only the fragment stem in `flow`.
  if (step.kind === "run") return `run ${wireText(step.flow, 128) ?? ""}`.trim();
  return kind;
}

/**
 * Unpack flow-execute's structured step report into MCP content blocks. Only
 * steps that carry a tool result surface their (image-bearing) content inline;
 * directive steps (tap/assert/expect/run/skip) render as a status line. This
 * never calls toMcpContent on an undefined result, which would serialize to an
 * invalid (text: undefined) content block.
 */
export async function flowRunToMcpContent(
  result: FlowExecuteResult,
  ctx?: ContentContext
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  // One image for the whole run, spent by whichever failure comes first.
  const budget: ImageBudget = { used: false };
  const failures: PendingFailure[] = [];

  if (result.executionPrerequisite) {
    blocks.push({ type: "text", text: `Prerequisite: ${result.executionPrerequisite}` });
  }

  blocks.push({
    type: "text",
    text: `Running flow "${result.flow}"${result.device ? ` on ${result.device}` : ""} (${result.steps.length} steps)`,
  });

  // Echo narration is not numbered, so the step number counts only real steps.
  //
  // It used to be the raw array position (`step.index + 1`), which disagreed
  // with every other surface the moment a flow carried an `echo:` — the
  // server's own `displayOrdinal` and the `failure.step.ordinal` it puts on the
  // wire, the CLI's step list and failure block, and the `step-NN-*` filenames
  // the export writes all skip echo. A leading echo is the idiom the skill docs
  // prescribe, so the disagreement was the common case, not an edge one.
  //
  // Derived here rather than read off `failure.step.ordinal` so the heading and
  // the step list above it stay in lockstep BY CONSTRUCTION: a heading saying
  // "3)" over a list showing the failure at 4 would be worse than no heading.
  let ordinal = 0;
  for (let i = 0; i < result.steps.length; i++) {
    const step = result.steps[i]!;
    const isEcho = step.kind === "echo";
    if (!isEcho) ordinal++;
    const num = ordinal;
    // Glyph only when a status is present (the new report). Legacy status-less
    // results render without one.
    const glyph = step.status ? `${STATUS_GLYPH[step.status] ?? "•"} ` : "";
    // `reason` is the new field; `error` is the legacy one.
    const reason = step.reason ?? step.error;
    const suffix = reason ? ` — ${reason}` : "";
    const warning = step.warning ? ` ⚠ ${step.warning}` : "";
    // Narration carries the `›` marker instead of an index — the same spelling
    // the CLI uses — so an unnumbered line still reads as belonging to the run.
    const head = isEcho ? "› " : `[${num}] `;
    blocks.push({
      type: "text",
      text: `${head}${glyph}${stepIndent(step.depth)}${stepLabel(step)}${suffix}${warning}`,
    });

    // Surface a step's own content (e.g. a screenshot) only when it actually
    // returned one.
    if (step.result !== undefined) {
      blocks.push(...(await toMcpContent(step.result, step.outputHint, ctx, step.args)));
    }

    // Snapshot steps carry artifacts instead of a result — list their paths,
    // and inline the annotated diff image when the assertion failed (once per
    // run, not once per failing step).
    if (isRecord(step.artifacts)) {
      // A snapshot registers `current` (and `diff`) itself, independently of
      // the failure diagnostics — so the producer declining `failure.screenshot`
      // on a secret run removes only a POINTER. Inlining either image here
      // would hand the agent the same screen as pixels and defeat the omission
      // whose own text says "a capture of this screen could reveal it".
      const secretTyped =
        isRecord(step.failure) &&
        isRecord(step.failure.data) &&
        step.failure.data.screenshotOmitted === "secret-typed";
      blocks.push(
        ...(await stepArtifactBlocks(
          step.artifacts,
          step.status,
          budget,
          ctx,
          step.depth,
          secretTyped
        ))
      );
    }

    // Structured diagnosis, rendered in one section after the summary so the
    // step list stays a scannable timeline. Absent on older tool-servers.
    //
    // Not for narration: an echo has no step number, so a `failure` on one —
    // which no honest server sends, since echo only ever passes or skips —
    // would head its block with the PREVIOUS step's number, or with 0 before
    // any real step has run. The CLI's `renderFailures` drops them for the same
    // reason.
    if (!isEcho && isRecord(step.failure)) failures.push({ num, step, failure: step.failure });
  }

  if (result.ok !== undefined) {
    // Narration steps are not counted, so a flow of only narration counts
    // nothing — say so rather than reporting four zeros on a passing run.
    const counted =
      (result.passed ?? 0) + (result.failed ?? 0) + (result.errored ?? 0) + (result.skipped ?? 0);
    const note = result.ok && counted === 0 ? " (no test steps)" : "";
    blocks.push({
      type: "text",
      text: `${result.ok ? "PASS" : "FAIL"} — ${result.passed ?? 0} passed, ${result.failed ?? 0} failed, ${result.errored ?? 0} errored, ${result.skipped ?? 0} skipped${note}`,
    });
  } else {
    blocks.push({ type: "text", text: `Flow "${result.flow}" complete.` });
  }

  blocks.push(...(await failureBlocks(failures, budget, ctx)));
  return blocks;
}

/**
 * Render a step's artifacts (snapshot baseline/current/diff): one text block
 * listing each artifact, plus the annotated diff image inline when the step
 * failed — otherwise the agent has no way to see WHAT differed. Only that
 * inlined diff is materialized (local read or remote download); baseline and
 * current are full-res PNGs nobody renders, so their handles print as
 * tool-server paths (or filenames) without pulling the bytes over the wire —
 * the same economy flow-visual.ts applies by omitting artifacts on a clean
 * pass. A legacy string[] (pre-handle tool-servers) renders its paths as
 * plain text. Lines shift with the step's depth indent so they stay attached
 * to a nested step's label, matching the CLI renderer.
 *
 * The inline diff is charged against the RUN's one-image `budget`: a flow that
 * fails several snapshot steps inlines the first diff and prints paths for the
 * rest, rather than spending a full-screen image on every one of them.
 */
async function stepArtifactBlocks(
  artifacts: Record<string, unknown>,
  status: string | undefined,
  budget: ImageBudget,
  ctx?: ContentContext,
  depth?: number,
  secretTyped = false
): Promise<ContentBlock[]> {
  // Never inline when the run typed a secret: pixels are the one projection no
  // scrubber reaches, and these images are of the same screen the producer
  // declined to capture. Paths still print — an operator can open one
  // deliberately; what must not happen is the bytes entering model context.
  const failed = (status === "fail" || status === "error") && !secretTyped;
  const entries: [string, string][] = [];
  let diffImage: ContentBlock | undefined;
  // The annotated `diff` is the most informative image — but the three snapshot
  // shapes that produce none (baseline-missing, dimension-mismatch,
  // crop-empty) still carry `current`, which is the only picture of what
  // failed. Inlining it HERE, beside its own path, is what lets the failure
  // block stop re-rendering the same image under a second, materialized path.
  const inlineRole = isArtifactHandle(artifacts.diff) ? "diff" : "current";

  for (const [k, v] of Object.entries(artifacts)) {
    if (ctx && failed && !budget.used && k === inlineRole && isArtifactHandle(v)) {
      // The one artifact rendered inline: materialize it so the image works
      // against a remote tool-server too.
      const { result, images } = await materializeArtifacts(v, ctx);
      // A null means the handle couldn't be fetched; say so rather than
      // rendering a dangling reference.
      entries.push([k, typeof result === "string" ? result : "(unavailable)"]);
      const img = images.find((i) => i.localPath === result);
      if (img) {
        diffImage = imageBlock(img.data, img.mimeType);
        // Charged only when an image actually materialized — a failed fetch
        // must not deny the next failure its one image.
        budget.used = true;
      }
    } else if (isArtifactHandle(v)) {
      entries.push([k, v.hostPath ?? v.filename]);
    } else if (typeof v === "string") {
      entries.push([k, v]);
    }
  }

  const indent = stepIndent(depth);
  const blocks: ContentBlock[] =
    entries.length > 0
      ? [{ type: "text", text: entries.map(([k, v]) => `  ${indent}${k}: ${v}`).join("\n") }]
      : [];
  if (diffImage) blocks.push(diffImage);
  return blocks;
}
