import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  toMcpContent,
  screenshotDiffToMcpContent,
  isScreenshotDiffResult,
  flowRunToMcpContent,
  type FlowExecuteResult,
} from "../src/content.js";
import { ARTIFACT_MARKER, type ArtifactHandle } from "@argent/tools-client";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function artifactHandle(id: string, filename: string, mimeType: string): ArtifactHandle {
  return { [ARTIFACT_MARKER]: true, id, filename, mimeType, size: 0 };
}

function fetchReturning(bytes: number[]): typeof fetch {
  return (async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  })) as unknown as typeof fetch;
}

const mockOk = (bytes: number[]) =>
  vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array(bytes).buffer });

// ── toMcpContent ─────────────────────────────────────────────────────

describe("toMcpContent", () => {
  it("returns JSON text block for plain results", async () => {
    const result = await toMcpContent({ foo: "bar" });
    expect(result).toEqual([{ type: "text", text: JSON.stringify({ foo: "bar" }, null, 2) }]);
  });

  it("returns JSON text block when outputHint is not image", async () => {
    const result = await toMcpContent({ url: "http://x" }, "other");
    expect(result).toEqual([
      {
        type: "text",
        text: JSON.stringify({ url: "http://x" }, null, 2),
      },
    ]);
  });

  it("fetches and base64-encodes image when outputHint is image", async () => {
    const pngBytes = [...PNG_SIGNATURE, 0xde, 0xad];
    vi.stubGlobal("fetch", mockOk(pngBytes));

    const result = await toMcpContent(
      { url: "http://localhost/img.png", path: "/tmp/img.png" },
      "image"
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: "image",
      data: Buffer.from(pngBytes).toString("base64"),
      mimeType: "image/png",
    });
    expect(result[1]).toEqual({ type: "text", text: "Saved: /tmp/img.png" });

    vi.unstubAllGlobals();
  });

  it("returns text only and does not fetch when args.includeImageInContext is false", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await toMcpContent(
      {
        url: "http://localhost/img.png",
        path: "/tmp/img.png",
      },
      "image",
      undefined,
      { udid: "ABC", includeImageInContext: false }
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual([{ type: "text", text: "Saved: /tmp/img.png" }]);

    vi.unstubAllGlobals();
  });

  it("attaches the image when args.includeImageInContext is undefined or true", async () => {
    const pngBytes = new Uint8Array(PNG_SIGNATURE);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => pngBytes.buffer,
      })
    );

    const result = await toMcpContent(
      { url: "http://localhost/img.png", path: "/tmp/img.png" },
      "image",
      undefined,
      { udid: "ABC" }
    );

    expect(result[0]?.type).toBe("image");
    expect(result[1]).toEqual({ type: "text", text: "Saved: /tmp/img.png" });

    vi.unstubAllGlobals();
  });

  it("uses empty string for path when not present", async () => {
    vi.stubGlobal("fetch", mockOk(PNG_SIGNATURE));

    const result = await toMcpContent({ url: "http://x" }, "image");
    expect(result[1]).toEqual({ type: "text", text: "Saved: " });

    vi.unstubAllGlobals();
  });

  it("falls back to text when outputHint is image but no url", async () => {
    const result = await toMcpContent({ foo: 1 }, "image");
    expect(result).toEqual([{ type: "text", text: JSON.stringify({ foo: 1 }, null, 2) }]);
  });

  // Regression for #255 — fetched bytes that aren't a PNG must NOT be shipped
  // labelled as image/png. The three cases below cover what `fetch(url)` can
  // realistically return when the simulator-server's `/media/...` URL goes
  // sideways: a 404 with an empty body, a 200 with a non-PNG body (any
  // upstream error page), and the network throwing.
  it("returns a placeholder when fetch returns 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })
    );
    const result = await toMcpContent({ url: "http://x/missing.png" }, "image");
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("text");
    expect(result.find((b) => b.type === "image")).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("returns a placeholder when fetched bytes are not a PNG", async () => {
    vi.stubGlobal("fetch", mockOk(Array.from(Buffer.from("<!doctype html>"))));
    const result = await toMcpContent({ url: "http://x/wrong.png" }, "image");
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("text");
    expect(result.find((b) => b.type === "image")).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("returns a placeholder when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await toMcpContent({ url: "http://127.0.0.1:1/x.png" }, "image");
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("text");
    expect(result.find((b) => b.type === "image")).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("screenshotDiffToMcpContent", () => {
  it("returns a context image followed by the summary text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-mcp-content-"));
    const contextDiffPath = path.join(dir, "context.diff.png");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await fs.writeFile(contextDiffPath, pngBytes);

    const summary = [
      "Screenshot diff summary",
      "",
      "Overall:",
      "- status: unchanged",
      "- pixel_mismatch: 0% - no pixel change",
    ].join("\n");

    const content = await screenshotDiffToMcpContent({
      summary,
      diffPath: path.join(dir, "full.diff.png"),
      contextDiffPath,
    });

    expect(content).toEqual([
      {
        type: "image",
        data: pngBytes.toString("base64"),
        mimeType: "image/png",
      },
      { type: "text", text: summary },
    ]);
  });

  it("returns only the summary text when no context image is present", async () => {
    const summary = [
      "Screenshot diff summary",
      "",
      "Overall:",
      "- status: dimension_mismatch",
      "- dimension_mismatch: expected=2x1 actual=1x2",
    ].join("\n");

    const content = await screenshotDiffToMcpContent({ summary });

    expect(content).toEqual([{ type: "text", text: summary }]);
  });
});

// ── isScreenshotDiffResult ───────────────────────────────────────────

describe("isScreenshotDiffResult", () => {
  it("returns true for values carrying a string summary", () => {
    expect(isScreenshotDiffResult({ summary: "hello" })).toBe(true);
    expect(isScreenshotDiffResult({ summary: "hello", contextDiffPath: "/tmp/x.png" })).toBe(true);
  });

  it("returns false for non-object values or missing summary", () => {
    expect(isScreenshotDiffResult(null)).toBe(false);
    expect(isScreenshotDiffResult("string")).toBe(false);
    expect(isScreenshotDiffResult({})).toBe(false);
    expect(isScreenshotDiffResult({ summary: 123 })).toBe(false);
  });
});

// ── toMcpContent with artifact context (remote-aware path) ───────────

describe("toMcpContent with artifact ctx", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "content-artifacts-"));
    process.env.ARGENT_ARTIFACTS_DIR = root;
  });

  afterEach(async () => {
    delete process.env.ARGENT_ARTIFACTS_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("materializes an image artifact and renders image + local Saved path", async () => {
    const pngBytes = [...PNG_SIGNATURE, 0x42];
    const result = await toMcpContent(
      { image: artifactHandle("img1", "shot.png", "image/png") },
      "image",
      { toolsUrl: "http://remote:3001", deviceId: "DEV-1", fetchImpl: fetchReturning(pngBytes) }
    );

    expect(result[0]).toEqual({
      type: "image",
      data: Buffer.from(pngBytes).toString("base64"),
      mimeType: "image/png",
    });
    expect(result[1]?.type).toBe("text");
    expect((result[1] as { text: string }).text).toMatch(/^Saved: .*shot\.png$/);
  });

  it("rewrites non-image artifacts to local paths inside the JSON result", async () => {
    const result = await toMcpContent(
      { exportedFiles: { cpu: artifactHandle("cpu1", "cpu.xml", "application/xml") } },
      undefined,
      { toolsUrl: "http://remote:3001", fetchImpl: fetchReturning([1, 2, 3]) }
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("text");
    expect((result[0] as { text: string }).text).toContain("cpu.xml");
  });
});

// ── flowRunToMcpContent ──────────────────────────────────────────────

describe("flowRunToMcpContent", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("produces header and footer text blocks", async () => {
    const input: FlowExecuteResult = { flow: "test", steps: [] };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks[0]).toEqual({
      type: "text",
      text: 'Running flow "test" (0 steps)',
    });
    expect(blocks[blocks.length - 1]).toEqual({
      type: "text",
      text: 'Flow "test" complete.',
    });
  });

  it("renders echo steps as text", async () => {
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [{ kind: "echo", message: "Hello" }],
    };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks[1]).toEqual({ type: "text", text: "[1] Hello" });
  });

  it("renders legacy tool error steps (status-less)", async () => {
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [{ kind: "tool", tool: "gesture-tap", error: "connection lost" }],
    };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks[1]).toEqual({
      type: "text",
      text: "[1] gesture-tap — connection lost",
    });
  });

  it("renders the new report shape: status glyphs, reasons, directive kinds, and summary", async () => {
    const input: FlowExecuteResult = {
      flow: "checkout",
      device: "SIM",
      ok: false,
      passed: 2,
      failed: 1,
      errored: 0,
      skipped: 1,
      steps: [
        { index: 0, kind: "tap", status: "pass" },
        { index: 1, kind: "assert", status: "pass" },
        { index: 2, kind: "snapshot", status: "fail", reason: "diff 3.10% > 0.5% (home)" },
        { index: 3, kind: "echo", status: "skip", message: "done" },
      ],
    };
    const blocks = await flowRunToMcpContent(input);
    const texts = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    expect(texts[0]).toBe('Running flow "checkout" on SIM (4 steps)');
    expect(texts[1]).toBe("[1] ✓ tap");
    expect(texts[2]).toBe("[2] ✓ assert");
    expect(texts[3]).toBe("[3] ✗ snapshot — diff 3.10% > 0.5% (home)");
    expect(texts[4]).toBe("[4] · done");
    expect(texts[texts.length - 1]).toBe("FAIL — 2 passed, 1 failed, 0 errored, 1 skipped");
    // No invalid (text: undefined) blocks even though directive steps carry no result.
    expect(blocks.every((b) => b.type !== "text" || typeof b.text === "string")).toBe(true);
  });

  it("renders tool success as JSON text", async () => {
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [{ kind: "tool", tool: "gesture-tap", result: { ok: true } }],
    };
    const blocks = await flowRunToMcpContent(input);

    // [0] header, [1] tool name, [2] JSON result, [3] footer
    expect(blocks[1]).toEqual({ type: "text", text: "[1] gesture-tap" });
    expect(blocks[2]).toEqual({
      type: "text",
      text: JSON.stringify({ ok: true }, null, 2),
    });
  });

  it("renders image tool results as image blocks", async () => {
    const pngBytes = [...PNG_SIGNATURE, 0x01];
    vi.stubGlobal("fetch", mockOk(pngBytes));

    const input: FlowExecuteResult = {
      flow: "f",
      steps: [
        {
          kind: "tool",
          tool: "screenshot",
          result: { url: "http://localhost/img.png", path: "/tmp/s.png" },
          outputHint: "image",
        },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    // [0] header, [1] "screenshot", [2] image, [3] "Saved: ...", [4] footer
    expect(blocks[1]).toEqual({ type: "text", text: "[1] screenshot" });
    expect(blocks[2]).toEqual({
      type: "image",
      data: Buffer.from(pngBytes).toString("base64"),
      mimeType: "image/png",
    });
    expect(blocks[3]).toEqual({ type: "text", text: "Saved: /tmp/s.png" });

    vi.unstubAllGlobals();
  });

  it("renders a text placeholder when an image step's fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })
    );

    const blocks = await flowRunToMcpContent({
      flow: "f",
      steps: [
        {
          kind: "tool",
          tool: "screenshot",
          result: { url: "http://x/gone.png", path: "/tmp/s.png" },
          outputHint: "image",
        },
      ],
    });

    expect(blocks[1]).toEqual({ type: "text", text: "[1] screenshot" });
    expect(blocks[2]?.type).toBe("text");
    expect(blocks.find((b) => b.type === "image")).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("suppresses image attach when step.args.includeImageInContext is false", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const input: FlowExecuteResult = {
      flow: "f",
      steps: [
        {
          kind: "tool",
          tool: "screenshot",
          result: { url: "http://localhost/img.png", path: "/tmp/s.png" },
          outputHint: "image",
          args: { udid: "ABC", includeImageInContext: false, scale: 1.0 },
        },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    expect(mockFetch).not.toHaveBeenCalled();
    // [0] header, [1] "screenshot", [2] "Saved: ...", [3] footer
    expect(blocks[1]).toEqual({ type: "text", text: "[1] screenshot" });
    expect(blocks[2]).toEqual({ type: "text", text: "Saved: /tmp/s.png" });

    vi.unstubAllGlobals();
  });

  it("handles mixed steps in order", async () => {
    const input: FlowExecuteResult = {
      flow: "mixed",
      steps: [
        { kind: "echo", message: "Start" },
        { kind: "tool", tool: "gesture-tap", result: { x: 1 } },
        { kind: "echo", message: "End" },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    const texts = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    expect(texts[0]).toContain("Running flow");
    expect(texts[1]).toBe("[1] Start");
    expect(texts[2]).toBe("[2] gesture-tap");
    // [3] is JSON result
    expect(texts[4]).toBe("[3] End");
    expect(texts[5]).toContain("complete");
  });

  it("numbers steps sequentially", async () => {
    const input: FlowExecuteResult = {
      flow: "num",
      steps: [
        { kind: "echo", message: "A" },
        { kind: "echo", message: "B" },
        { kind: "echo", message: "C" },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks[1]).toEqual({ type: "text", text: "[1] A" });
    expect(blocks[2]).toEqual({ type: "text", text: "[2] B" });
    expect(blocks[3]).toEqual({ type: "text", text: "[3] C" });
  });
});
