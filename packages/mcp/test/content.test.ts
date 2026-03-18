import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  toMcpContent,
  flowRunToMcpContent,
  type FlowExecuteResult,
} from "../src/content.js";

// ── toMcpContent ─────────────────────────────────────────────────────

describe("toMcpContent", () => {
  it("returns JSON text block for plain results", async () => {
    const result = await toMcpContent({ foo: "bar" });
    expect(result).toEqual([
      { type: "text", text: JSON.stringify({ foo: "bar" }, null, 2) },
    ]);
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
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const mockFetch = vi.fn().mockResolvedValue({
      arrayBuffer: async () => pngBytes.buffer,
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await toMcpContent(
      { url: "http://localhost/img.png", path: "/tmp/img.png" },
      "image",
    );

    expect(mockFetch).toHaveBeenCalledWith("http://localhost/img.png");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: "image",
      data: Buffer.from(pngBytes).toString("base64"),
      mimeType: "image/png",
    });
    expect(result[1]).toEqual({ type: "text", text: "Saved: /tmp/img.png" });

    vi.unstubAllGlobals();
  });

  it("uses empty string for path when not present", async () => {
    const pngBytes = new Uint8Array([0x89]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        arrayBuffer: async () => pngBytes.buffer,
      }),
    );

    const result = await toMcpContent({ url: "http://x" }, "image");
    expect(result[1]).toEqual({ type: "text", text: "Saved: " });

    vi.unstubAllGlobals();
  });

  it("falls back to text when outputHint is image but no url", async () => {
    const result = await toMcpContent({ foo: 1 }, "image");
    expect(result).toEqual([
      { type: "text", text: JSON.stringify({ foo: 1 }, null, 2) },
    ]);
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

  it("renders tool error steps", async () => {
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [{ kind: "tool", tool: "tap", error: "connection lost" }],
    };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks[1]).toEqual({
      type: "text",
      text: "[1] tap ERROR: connection lost",
    });
  });

  it("renders tool success as JSON text", async () => {
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [
        { kind: "tool", tool: "tap", result: { ok: true } },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    // [0] header, [1] tool name, [2] JSON result, [3] footer
    expect(blocks[1]).toEqual({ type: "text", text: "[1] tap" });
    expect(blocks[2]).toEqual({
      type: "text",
      text: JSON.stringify({ ok: true }, null, 2),
    });
  });

  it("renders image tool results as image blocks", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        arrayBuffer: async () => pngBytes.buffer,
      }),
    );

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

  it("handles mixed steps in order", async () => {
    const input: FlowExecuteResult = {
      flow: "mixed",
      steps: [
        { kind: "echo", message: "Start" },
        { kind: "tool", tool: "tap", result: { x: 1 } },
        { kind: "echo", message: "End" },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    const texts = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    expect(texts[0]).toContain("Running flow");
    expect(texts[1]).toBe("[1] Start");
    expect(texts[2]).toBe("[2] tap");
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
