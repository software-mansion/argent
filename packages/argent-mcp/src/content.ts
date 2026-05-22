/**
 * Convert raw tool results into MCP content blocks (text / image).
 *
 * Extracted so it can be tested independently of the MCP server wiring.
 */

import { readFile } from "node:fs/promises";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ScreenshotDiffResult {
  summary: string;
  diffPath?: string;
  contextDiffPath?: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Fetch image bytes and confirm they actually start with a PNG signature.
// Without this check, a 404 (file missing), an HTML error page, or any other
// non-PNG response would be base64'd and labelled `image/png`, which the
// model API rejects with "Image could not be processed" (issue #255).
async function fetchPngBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
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
  args?: unknown
): Promise<ContentBlock[]> {
  if (outputHint === "screenshot-diff" && isScreenshotDiffResult(result)) {
    const blocks: ContentBlock[] = [];

    if (typeof result.contextDiffPath === "string") {
      const buf = await readFile(result.contextDiffPath);
      blocks.push({
        type: "image" as const,
        data: buf.toString("base64"),
        mimeType: "image/png" as const,
      });
    }

    blocks.push({ type: "text" as const, text: result.summary });
    return blocks;
  }

  if (outputHint === "image" && result && typeof result === "object" && "url" in result) {
    const r = result as { url: string; path?: string };
    if (isRecord(args) && args.includeImageInContext === false) {
      return [{ type: "text" as const, text: `Saved: ${r.path}` }];
    }

    const buf = await fetchPngBytes(r.url);
    if (buf) {
      return [
        {
          type: "image" as const,
          data: buf.toString("base64"),
          mimeType: "image/png" as const,
        },
        { type: "text" as const, text: `Saved: ${r.path ?? ""}` },
      ];
    }
    return [
      {
        type: "text" as const,
        text: `(Screenshot unavailable: no valid PNG at ${r.url}. Take a new screenshot.)`,
      },
    ];
  }

  return [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isScreenshotDiffResult(value: unknown): value is ScreenshotDiffResult {
  if (!isRecord(value)) return false;
  return typeof value.summary === "string";
}

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
export async function flowRunToMcpContent(result: FlowExecuteResult): Promise<ContentBlock[]> {
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
      const stepContent = await toMcpContent(step.result, step.outputHint, step.args);
      blocks.push(...stepContent);
    }
  }

  blocks.push({ type: "text", text: `Flow "${result.flow}" complete.` });
  return blocks;
}
