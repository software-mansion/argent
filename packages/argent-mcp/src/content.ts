/**
 * Convert raw tool results into MCP content blocks (text / image).
 *
 * Extracted so it can be tested independently of the MCP server wiring.
 */

import { readFile } from "node:fs/promises";
import { materializeArtifacts, type MaterializeContext } from "@argent/tools-client";

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

    const blocks: ContentBlock[] = [{ type: "text", text: JSON.stringify(rewritten, null, 2) }];
    // Surface any images that rode along on a non-image result.
    if (!suppressImage) for (const img of images) blocks.push(imageBlock(img.data, img.mimeType));
    return blocks;
  }

  if (outputHint === "image") {
    return legacyImageContent(result, suppressImage);
  }

  return [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
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

export type FlowExecuteResult = {
  flow: string;
  executionPrerequisite?: string;
  steps: {
    kind: string;
    tool?: string;
    message?: string;
    result?: unknown;
    outputHint?: string;
    args?: unknown;
    error?: string;
  }[];
};

/**
 * Unpack flow-execute's structured step results into MCP content blocks.
 * Each step carries its own outputHint so toMcpContent handles images correctly.
 */
export async function flowRunToMcpContent(
  result: FlowExecuteResult,
  ctx?: ContentContext
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  if (result.executionPrerequisite) {
    blocks.push({
      type: "text",
      text: `Prerequisite: ${result.executionPrerequisite}`,
    });
  }

  blocks.push({
    type: "text",
    text: `Running flow "${result.flow}" (${result.steps.length} steps)`,
  });

  for (let i = 0; i < result.steps.length; i++) {
    const step = result.steps[i]!;
    const num = i + 1;

    if (step.kind === "echo") {
      blocks.push({ type: "text", text: `[${num}] ${step.message}` });
    } else if ("error" in step && step.error) {
      blocks.push({
        type: "text",
        text: `[${num}] ${step.tool} ERROR: ${step.error}`,
      });
    } else {
      blocks.push({ type: "text", text: `[${num}] ${step.tool}` });
      const stepContent = await toMcpContent(step.result, step.outputHint, ctx, step.args);
      blocks.push(...stepContent);
    }
  }

  blocks.push({ type: "text", text: `Flow "${result.flow}" complete.` });
  return blocks;
}
