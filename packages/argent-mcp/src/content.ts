/**
 * Convert raw tool results into MCP content blocks (text / image).
 *
 * Extracted so it can be tested independently of the MCP server wiring.
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export async function toMcpContent(result: unknown, outputHint?: string): Promise<ContentBlock[]> {
  if (outputHint === "image" && result && typeof result === "object") {
    const r = result as { url?: string; path?: string };
    const buf = await loadImageBytes(r);
    if (buf) {
      return [
        {
          type: "image" as const,
          data: buf.toString("base64"),
          mimeType: "image/png" as const,
        },
        { type: "text" as const, text: `Saved: ${r.path ?? r.url ?? ""}` },
      ];
    }
  }

  return [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
}

/**
 * Resolve image bytes from a tool result with `{url, path}`. Tries `url`
 * first via fetch (works for the simulator-server's `/media/...` URLs); if
 * that fails or `url` is a `file://` reference (the simctl fallback), reads
 * `path` directly from disk. Returns null if both paths fail so the caller
 * can fall back to a text representation.
 */
async function loadImageBytes(r: { url?: string; path?: string }): Promise<Buffer | null> {
  if (r.url && !r.url.startsWith("file://")) {
    try {
      const res = await fetch(r.url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
      // Fall through to path-based read.
    }
  }
  if (r.path) {
    try {
      const fs = await import("node:fs/promises");
      return await fs.readFile(r.path);
    } catch {
      // Last resort: nothing to return.
    }
  }
  return null;
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
      const stepContent = await toMcpContent(step.result, step.outputHint);
      blocks.push(...stepContent);
    }
  }

  blocks.push({ type: "text", text: `Flow "${result.flow}" complete.` });
  return blocks;
}
