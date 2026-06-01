/**
 * Convert raw tool results into MCP content blocks (text / image).
 *
 * Extracted so it can be tested independently of the MCP server wiring.
 */

import { materializeArtifacts, type MaterializeContext } from "./artifacts.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Context for resolving artifact handles in a result. When omitted, content
 * rendering falls back to the legacy `{ url, path }` screenshot shape (used by
 * older tool-servers and by unit tests that don't exercise the artifact path).
 */
export type ContentContext = MaterializeContext;

function imageBlock(data: Buffer, mimeType: string): ContentBlock {
  return { type: "image", data: data.toString("base64"), mimeType };
}

export async function toMcpContent(
  result: unknown,
  outputHint?: string,
  ctx?: ContentContext
): Promise<ContentBlock[]> {
  // Artifact path: when a context is available, resolve handles to local files.
  // Tools producing files (screenshots, profiler exports) return artifact
  // handles instead of host paths, so this works regardless of where the
  // tool-server runs.
  if (ctx) {
    const { result: rewritten, images } = await materializeArtifacts(result, ctx);

    if (outputHint === "image") {
      if (images.length > 0) {
        const blocks: ContentBlock[] = images.map((img) => imageBlock(img.data, img.mimeType));
        blocks.push({ type: "text", text: `Saved: ${images[0]!.localPath}` });
        return blocks;
      }
      // No image artifact present — fall back to the legacy `{ url, path }`
      // shape for older tool-servers.
      return legacyImageContent(rewritten);
    }

    const blocks: ContentBlock[] = [{ type: "text", text: JSON.stringify(rewritten, null, 2) }];
    // Surface any images that rode along on a non-image result.
    for (const img of images) blocks.push(imageBlock(img.data, img.mimeType));
    return blocks;
  }

  if (outputHint === "image") {
    return legacyImageContent(result);
  }

  return [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
}

/** Legacy screenshot rendering: fetch the `{ url, path }` media URL directly. */
async function legacyImageContent(result: unknown): Promise<ContentBlock[]> {
  if (result && typeof result === "object" && "url" in result) {
    const imgRes = await fetch((result as { url: string }).url);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const filePath = (result as { path?: string }).path ?? "";
    return [imageBlock(buf, "image/png"), { type: "text", text: `Saved: ${filePath}` }];
  }
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
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
      const stepContent = await toMcpContent(step.result, step.outputHint, ctx);
      blocks.push(...stepContent);
    }
  }

  blocks.push({ type: "text", text: `Flow "${result.flow}" complete.` });
  return blocks;
}
