/**
 * Convert raw tool results into MCP content blocks (text / image).
 *
 * Extracted so it can be tested independently of the MCP server wiring.
 */

import { readFile } from "node:fs/promises";
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

export type FlowStepResult = {
  index?: number;
  kind: string;
  status?: "pass" | "fail" | "skip" | "error";
  reason?: string;
  /**
   * Legacy: older tool-servers passed a snapshot that adopted a missing
   * baseline and annotated it with this caveat (a missing baseline now fails
   * the step). Rendered for wire compat with a not-yet-updated server.
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
   * Nesting depth: absent/0 at top level, +1 inside each block directive
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

function stepLabel(step: FlowStepResult): string {
  if (step.kind === "echo") return step.message ?? "";
  if (step.kind === "run") return `run ${step.flow ?? ""}`.trim();
  if (step.tool) return step.tool;
  if (step.target) return `${step.kind} ${step.target}`;
  return step.kind;
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

  if (result.executionPrerequisite) {
    blocks.push({ type: "text", text: `Prerequisite: ${result.executionPrerequisite}` });
  }

  blocks.push({
    type: "text",
    text: `Running flow "${result.flow}"${result.device ? ` on ${result.device}` : ""} (${result.steps.length} steps)`,
  });

  for (let i = 0; i < result.steps.length; i++) {
    const step = result.steps[i]!;
    const num = step.index !== undefined ? step.index + 1 : i + 1;
    // Glyph only when a status is present (the new report). Legacy status-less
    // results render without one.
    const glyph = step.status ? `${STATUS_GLYPH[step.status] ?? "•"} ` : "";
    // `reason` is the new field; `error` is the legacy one.
    const reason = step.reason ?? step.error;
    const suffix = reason ? ` — ${reason}` : "";
    const warning = step.warning ? ` ⚠ ${step.warning}` : "";
    blocks.push({
      type: "text",
      text: `[${num}] ${glyph}${stepIndent(step.depth)}${stepLabel(step)}${suffix}${warning}`,
    });

    // Surface a step's own content (e.g. a screenshot) only when it actually
    // returned one.
    if (step.result !== undefined) {
      blocks.push(...(await toMcpContent(step.result, step.outputHint, ctx, step.args)));
    }

    // Snapshot steps carry artifacts instead of a result — list their paths,
    // and inline the annotated diff image when the assertion failed.
    if (isRecord(step.artifacts)) {
      blocks.push(...(await stepArtifactBlocks(step.artifacts, step.status, ctx, step.depth)));
    }
  }

  if (result.ok !== undefined) {
    blocks.push({
      type: "text",
      text: `${result.ok ? "PASS" : "FAIL"} — ${result.passed ?? 0} passed, ${result.failed ?? 0} failed, ${result.errored ?? 0} errored, ${result.skipped ?? 0} skipped`,
    });
  } else {
    blocks.push({ type: "text", text: `Flow "${result.flow}" complete.` });
  }
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
 */
async function stepArtifactBlocks(
  artifacts: Record<string, unknown>,
  status: string | undefined,
  ctx?: ContentContext,
  depth?: number
): Promise<ContentBlock[]> {
  const failed = status === "fail" || status === "error";
  const entries: [string, string][] = [];
  let diffImage: ContentBlock | undefined;

  for (const [k, v] of Object.entries(artifacts)) {
    if (ctx && failed && k === "diff" && isArtifactHandle(v)) {
      // The one artifact rendered inline: materialize it so the image works
      // against a remote tool-server too.
      const { result, images } = await materializeArtifacts(v, ctx);
      // A null means the handle couldn't be fetched; say so rather than
      // rendering a dangling reference.
      entries.push([k, typeof result === "string" ? result : "(unavailable)"]);
      const img = images.find((i) => i.localPath === result);
      if (img) diffImage = imageBlock(img.data, img.mimeType);
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
