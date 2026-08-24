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
  type FlowStepResult,
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

  it("renders echo steps as unnumbered narration", async () => {
    // Narration is not a step: numbering it would push every real step's index
    // one past the number the CLI, the export filenames and
    // `failure.step.ordinal` all use. The `›` marker is the CLI's spelling.
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [{ kind: "echo", message: "Hello" }],
    };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks[1]).toEqual({ type: "text", text: "› Hello" });
  });

  it("renders run steps by their as-written path, with a stem fallback for legacy servers", async () => {
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [
        // Two same-stem targets must render distinctly — the path is the label.
        { index: 0, kind: "run", status: "pass", flow: "login", target: "ios/login.yaml" },
        { index: 1, kind: "run", status: "pass", flow: "login", target: "android/login.yaml" },
        // A pre-target tool-server sends only the stem.
        { index: 2, kind: "run", status: "pass", flow: "login" },
      ],
    };
    const blocks = await flowRunToMcpContent(input);
    const texts = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    expect(texts).toContain("[1] ✓ run ios/login.yaml");
    expect(texts).toContain("[2] ✓ run android/login.yaml");
    expect(texts).toContain("[3] ✓ run login");
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

  it("indents step labels by nesting depth, clamping hostile wire values", async () => {
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [
        { index: 0, kind: "when", status: "pass", target: 'visible "Promo"' },
        { index: 1, kind: "tap", status: "pass", target: '"Dismiss"', depth: 1 },
        { index: 2, kind: "echo", status: "pass", message: "deep note", depth: 2 },
        // Wire data is untrusted: a negative depth must not throw and a huge
        // one must not allocate a huge line.
        { index: 3, kind: "tap", status: "pass", target: '"A"', depth: -2 },
        { index: 4, kind: "tap", status: "pass", target: '"B"', depth: 1e9 },
        // The cap clamps, it does not discard: legitimate depth can exceed it
        // (the producer's run-chain and when-nesting limits accumulate), so a
        // too-deep step keeps the maximum indent rather than snapping flat.
        { index: 5, kind: "tap", status: "pass", target: '"C"', depth: 20 },
        { index: 6, kind: "tap", status: "pass", target: '"D"', depth: 21 },
      ],
    };
    const blocks = await flowRunToMcpContent(input);
    const texts = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    expect(texts).toContain('[1] ✓ when visible "Promo"');
    expect(texts).toContain('[2] ✓   tap "Dismiss"');
    // Narration keeps its indent but takes no number.
    expect(texts).toContain("› ✓     deep note");
    expect(texts).toContain('[3] ✓ tap "A"');
    const cap = "  ".repeat(20);
    expect(texts).toContain(`[4] ✓ ${cap}tap "B"`);
    expect(texts).toContain(`[5] ✓ ${cap}tap "C"`);
    expect(texts).toContain(`[6] ✓ ${cap}tap "D"`);
  });

  it("shifts snapshot artifact lines with the step's depth, matching the CLI renderer", async () => {
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "fail",
          reason: "diff 2.10% > 1%",
          target: '"home"',
          depth: 1,
          artifacts: { baseline: "/tmp/b.png" },
        },
      ],
    };
    const blocks = await flowRunToMcpContent(input);
    const artifactText = blocks.find(
      (b): b is { type: "text"; text: string } => b.type === "text" && b.text.includes("baseline:")
    );
    // Two-space prefix, then the step's indent — under the indented label,
    // not left of it.
    expect(artifactText?.text).toBe("    baseline: /tmp/b.png");
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
    expect(texts[4]).toBe("› · done");
    expect(texts[texts.length - 1]).toBe("FAIL — 2 passed, 1 failed, 0 errored, 1 skipped");
    // No invalid (text: undefined) blocks even though directive steps carry no result.
    expect(blocks.every((b) => b.type !== "text" || typeof b.text === "string")).toBe(true);
  });

  it("surfaces a legacy passed step's warning on its status line (older tool-servers adopted missing baselines)", async () => {
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "pass",
          reason: "baseline created (home__ios-390x844.png)",
          warning: 'no baseline existed for "home" — nothing was compared',
        },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks[1]).toEqual({
      type: "text",
      text: '[1] ✓ snapshot — baseline created (home__ios-390x844.png) ⚠ no baseline existed for "home" — nothing was compared',
    });
  });

  it("materializes only the diff and inlines it on failure", async () => {
    const pngBytes = [...PNG_SIGNATURE, 0x02];
    const fetchImpl = vi.fn(fetchReturning(pngBytes));
    const input: FlowExecuteResult = {
      flow: "checkout",
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "fail",
          reason: "diff 3.10% > 0.5% (home)",
          artifacts: {
            baseline: artifactHandle("b1", "home-baseline.png", "image/png"),
            current: artifactHandle("c1", "home-current.png", "image/png"),
            diff: artifactHandle("d1", "home-diff.png", "image/png"),
          },
        },
      ],
    };
    const blocks = await flowRunToMcpContent(input, {
      toolsUrl: "http://remote:3001",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const artifactText = blocks.find(
      (b): b is { type: "text"; text: string } => b.type === "text" && b.text.includes("baseline:")
    );
    expect(artifactText?.text).toContain("home-baseline.png");
    expect(artifactText?.text).toContain("home-current.png");
    expect(artifactText?.text).toMatch(/diff: .*home-diff\.png/);

    // Exactly one inline image — the diff, not the full-res baseline/current.
    const images = blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ data: Buffer.from(pngBytes).toString("base64") });

    // And exactly one download: baseline/current are referenced by name only,
    // never pulled over the wire just to print their paths.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/artifacts/d1");
  });

  it("lists snapshot artifact paths without fetching anything when the step passed", async () => {
    const fetchImpl = vi.fn(fetchReturning([...PNG_SIGNATURE, 0x03]));
    const input: FlowExecuteResult = {
      flow: "checkout",
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "pass",
          reason: "diff 0.00% ≤ 0.5% (home)",
          artifacts: {
            baseline: artifactHandle("b1", "home-baseline.png", "image/png"),
            current: artifactHandle("c1", "home-current.png", "image/png"),
          },
        },
      ],
    };
    const blocks = await flowRunToMcpContent(input, {
      toolsUrl: "http://remote:3001",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(blocks.find((b) => b.type === "image")).toBeUndefined();
    const artifactText = blocks.find(
      (b): b is { type: "text"; text: string } => b.type === "text" && b.text.includes("baseline:")
    );
    expect(artifactText?.text).toContain("home-baseline.png");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to artifact host paths when no materialize context is given", async () => {
    const input: FlowExecuteResult = {
      flow: "checkout",
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "fail",
          reason: "diff 3.10% > 0.5% (home)",
          artifacts: {
            baseline: {
              ...artifactHandle("b1", "base.png", "image/png"),
              hostPath: "/srv/base.png",
            },
            diff: { ...artifactHandle("d1", "diff.png", "image/png"), hostPath: "/srv/diff.png" },
          },
        },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks.find((b) => b.type === "image")).toBeUndefined();
    const artifactText = blocks.find(
      (b): b is { type: "text"; text: string } => b.type === "text" && b.text.includes("baseline:")
    );
    expect(artifactText?.text).toContain("baseline: /srv/base.png");
    expect(artifactText?.text).toContain("diff: /srv/diff.png");
  });

  it("renders legacy string[] artifacts as plain path lines", async () => {
    const input: FlowExecuteResult = {
      flow: "checkout",
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "fail",
          reason: "diff 3.10% > 0.5% (home)",
          artifacts: ["/srv/baseline.png", "/srv/current.png"] as unknown as Record<
            string,
            unknown
          >,
        },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    const artifactText = blocks.find(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && b.text.includes("/srv/baseline.png")
    );
    expect(artifactText).toBeDefined();
    expect(blocks.find((b) => b.type === "image")).toBeUndefined();
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
    expect(texts[1]).toBe("› Start");
    // The tool step is the only NUMBERED one — the narration around it is not.
    expect(texts[2]).toBe("[1] gesture-tap");
    // texts[3] is the tool's JSON result
    expect(texts[4]).toBe("› End");
    expect(texts[5]).toContain("complete");
  });

  it("numbers real steps sequentially, skipping the narration between them", async () => {
    // The number is the step's DISPLAY ordinal, which every other surface
    // derives the same way — the server's `failure.step.ordinal`, the CLI's
    // step list and failure block, and the `step-NN-*` export filenames.
    const input: FlowExecuteResult = {
      flow: "num",
      steps: [
        { kind: "echo", message: "A" },
        { kind: "tap", status: "pass", target: '"one"' },
        { kind: "echo", message: "B" },
        { kind: "tap", status: "pass", target: '"two"' },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks[1]).toEqual({ type: "text", text: "› A" });
    expect(blocks[2]).toEqual({ type: "text", text: '[1] ✓ tap "one"' });
    expect(blocks[3]).toEqual({ type: "text", text: "› B" });
    expect(blocks[4]).toEqual({ type: "text", text: '[2] ✓ tap "two"' });
  });
});

// ── flowRunToMcpContent: the Failures section ────────────────────────
//
// Context economy is the whole point of this renderer, so the assertions are
// mostly about what is NOT in the output: one image per run however many steps
// failed, five candidates however many were ranked, and the element tree as a
// path however many elements it holds.

describe("flowRunToMcpContent failure diagnostics", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "content-failures-"));
    process.env.ARGENT_ARTIFACTS_DIR = root;
  });

  afterEach(async () => {
    delete process.env.ARGENT_ARTIFACTS_DIR;
    await rm(root, { recursive: true, force: true });
  });

  const texts = (blocks: { type: string }[]): string[] =>
    blocks.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text);

  // A `failure` is untrusted wire JSON — a real tool-server sends fields this
  // renderer's narrow copy doesn't declare (`screen.elements`, `category`, …)
  // and a hostile one sends wrong types. Fixtures are plain objects, cast in
  // exactly one place, so the tests can express both.
  const wireFailure = (f: Record<string, unknown>): FlowStepResult["failure"] =>
    f as FlowStepResult["failure"];

  const candidate = (i: number) => ({
    node: {
      role: "button",
      label: `Check out ${i}`,
      identifier: `cta-${i}`,
      frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 },
    },
    score: 0.9 - i / 10,
    basis: "text-near",
    selectorYaml: `{ id: cta-${i} }`,
  });

  // A tree big enough that inlining it would be the exact regression this
  // renderer exists to avoid; each node carries a marker no other field uses.
  const bigTree = Array.from({ length: 80 }, (_, i) => ({
    role: "AXStaticText",
    label: `TREE-ONLY-NODE-${i}`,
    frame: { x: 0, y: i / 100, width: 1, height: 0.01 },
  }));

  /**
   * A run carrying TWO failures — deliberately a shape an honest tool-server
   * cannot produce. The runner hard-stops at the first non-passing leaf, so
   * one failure per run is the invariant `flow-failure-taxonomy` asserts; this
   * fixture is the buggy-or-hostile server the renderer's own bounds exist for
   * (MAX_RENDER_FAILURES, and the one-inlined-image-per-RUN budget). Testing
   * the image budget against a single-failure run could not distinguish a run
   * budget from a per-step one, which is the regression it guards.
   */
  function twoFailureRun(): FlowExecuteResult {
    return {
      flow: "checkout",
      device: "SIM-1",
      ok: false,
      passed: 1,
      failed: 1,
      errored: 1,
      skipped: 0,
      steps: [
        { index: 0, kind: "launch", status: "pass", target: "com.acme.shop", durationMs: 3100 },
        {
          index: 1,
          kind: "tap",
          status: "fail",
          target: '"Checkout"',
          durationMs: 5002,
          reason: 'no visible element matched selector text="Checkout"',
          failure: wireFailure({
            code: "selector-not-found",
            category: "selector",
            determinacy: "determinate",
            message: 'no visible element matched selector text="Checkout"',
            hint: "the closest match differs only by a space",
            candidates: Array.from({ length: 6 }, (_, i) => candidate(i)),
            candidateCount: 12,
            screen: {
              state: "available",
              source: "ax",
              capturedAt: "at-failure",
              elementCount: 47,
              // A tool-server DOES put the element list on the wire; this
              // renderer must never spend tokens on it.
              elements: bigTree,
            },
            screenshot: artifactHandle("shot1", "step-02-screen.png", "image/png"),
            tree: {
              ...artifactHandle("tree1", "step-02-tree.txt", "text/plain"),
              hostPath: "/srv/flow-artifacts/checkout/step-02-tree.txt",
            },
          }),
        },
        {
          index: 2,
          kind: "assert",
          status: "error",
          target: '"Order placed"',
          durationMs: 1200,
          reason: "the UI tree could not be read",
          failure: wireFailure({
            code: "tree-source-unavailable",
            category: "environment",
            determinacy: "indeterminate",
            message: "the UI tree could not be read",
            screen: {
              state: "unavailable",
              reason: "read-failed",
              detail: "native devtools is not connected",
            },
            cause: { code: "NATIVE_DEVTOOLS_NOT_CONNECTED", message: "helper exited" },
            screenshot: {
              ...artifactHandle("shot2", "step-03-screen.png", "image/png"),
              hostPath: "/srv/flow-artifacts/checkout/step-03-screen.png",
            },
            tree: {
              ...artifactHandle("tree2", "step-03-tree.txt", "text/plain"),
              hostPath: "/srv/flow-artifacts/checkout/step-03-tree.txt",
            },
          }),
        },
      ],
    };
  }

  it("inlines exactly one image for a two-failure run and materializes only the first failure's evidence", async () => {
    const pngBytes = [...PNG_SIGNATURE, 0x11];
    const fetchImpl = vi.fn(fetchReturning(pngBytes));

    const blocks = await flowRunToMcpContent(twoFailureRun(), {
      toolsUrl: "http://remote:3001",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const images = blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ data: Buffer.from(pngBytes).toString("base64") });

    // One download, and it is the FIRST failure's screenshot. The second
    // failure's screenshot and both tree dumps are referenced by path only.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/artifacts/shot1");
    const fetched = fetchImpl.mock.calls.map((c) => String(c[0])).join(" ");
    expect(fetched).not.toContain("shot2");
    expect(fetched).not.toContain("tree1");
    expect(fetched).not.toContain("tree2");

    const all = texts(blocks);
    // The second failure prints its screenshot path rather than inlining it.
    expect(all.join("\n")).toContain("screenshot: /srv/flow-artifacts/checkout/step-03-screen.png");
    // …and the run closes with a pointer at the rest of the evidence.
    expect(all).toContain("  (1 more failure — evidence at /srv/flow-artifacts/checkout)");
  });

  it("renders the section after the summary, with the code, determinacy framing and cause", async () => {
    const blocks = await flowRunToMcpContent(twoFailureRun());
    const all = texts(blocks);

    const summaryAt = all.findIndex((t) => t.startsWith("FAIL — "));
    const failuresAt = all.indexOf("Failures:");
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(failuresAt).toBeGreaterThan(summaryAt);

    const first = all.find((t) => t.startsWith("  2) tap"))!;
    expect(first.split("\n")[0]).toBe('  2) tap "Checkout" (5.0s)');
    expect(first).toContain(
      '     selector-not-found: no visible element matched selector text="Checkout"'
    );
    expect(first).toContain("     screen: 47 elements, captured at the failure, via ax");
    expect(first).toContain("     hint: the closest match differs only by a space");

    const second = all.find((t) => t.startsWith("  3) assert"))!;
    expect(second).toContain(
      "     indeterminate: argent could not see the screen — this is NOT a failed assertion."
    );
    expect(second).toContain(
      "     screen: unavailable (read-failed) — native devtools is not connected"
    );
    expect(second).toContain("     cause: NATIVE_DEVTOOLS_NOT_CONNECTED: helper exited");
  });

  it("caps candidates at five and gives each a normalized tap centre", async () => {
    const blocks = await flowRunToMcpContent(twoFailureRun());
    const first = texts(blocks).find((t) => t.startsWith("  2) tap"))!;
    const lines = first.split("\n");

    expect(lines).toContain(
      '     candidates (5 of 12, ranked; "at" is the normalized tap centre — verify by tapping it):'
    );
    // Frame centre: x + width/2, y + height/2 — the coordinates gesture-tap takes.
    expect(lines).toContain(
      '       0.90  "Check out 0"  button  id=cta-0  visible  at 0.50, 0.23  (text-near)  → { id: cta-0 }'
    );
    const rendered = lines.filter((l) => l.trimStart().startsWith("0."));
    expect(rendered).toHaveLength(5);
    // The sixth ranked candidate is dropped, not wrapped onto another line.
    expect(first).not.toContain("Check out 5");
  });

  it("emits the element tree as a path and never inlines the element list", async () => {
    const blocks = await flowRunToMcpContent(twoFailureRun());
    const all = texts(blocks).join("\n");

    expect(all).toContain(
      "     tree: /srv/flow-artifacts/checkout/step-02-tree.txt (read this file for the full element list)"
    );
    // Not one of the 80 elements the wire object carried reaches the output.
    expect(all).not.toContain("TREE-ONLY-NODE");
  });

  it("spends the run's one image on a failing snapshot's diff, leaving later failures path-only", async () => {
    const pngBytes = [...PNG_SIGNATURE, 0x12];
    const fetchImpl = vi.fn(fetchReturning(pngBytes));
    const input: FlowExecuteResult = {
      flow: "visual",
      ok: false,
      passed: 0,
      failed: 2,
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "fail",
          target: '"home"',
          reason: "diff 3.10% > 0.5% (home)",
          artifacts: { diff: artifactHandle("diff1", "home-diff.png", "image/png") },
          failure: wireFailure({ code: "snapshot-diff", message: "diff 3.10% > 0.5% (home)" }),
        },
        {
          index: 1,
          kind: "tap",
          status: "fail",
          target: '"Retry"',
          reason: "no visible element matched",
          failure: wireFailure({
            code: "selector-not-found",
            message: "no visible element matched",
            screenshot: artifactHandle("shot9", "step-02-screen.png", "image/png"),
          }),
        },
      ],
    };

    const blocks = await flowRunToMcpContent(input, {
      toolsUrl: "http://remote:3001",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/artifacts/diff1");
    const rendered = texts(blocks);
    expect(rendered.join("\n")).toContain("screenshot: step-02-screen.png");
    // A handle with no hostPath renders as a bare filename — no directory to
    // point at, so the pointer falls back to the generic wording.
    expect(rendered).toContain("  (1 more failure — evidence at the paths listed above)");
  });

  it("renders the expected slot for every arm, not just a text condition", async () => {
    // Gating the slot on `expected.text` left the scroll, snapshot, gesture and
    // text-less condition shapes rendering nothing at all, so `condition:
    // "visible"`, `timeoutMs` and `maxMismatch` never reached the agent.
    const arms = [
      [{ kind: "condition", condition: "visible", timeoutMs: 5000 }, "expected: visible"],
      [
        { kind: "condition", condition: "text", text: "Done", textMatch: "equals" },
        'expected: "Done" (equals)',
      ],
      [
        { kind: "scroll", direction: "down", within: 'id="list"', maxIterations: 12 },
        'expected: scroll down within id="list" (max 12 iterations)',
      ],
      [
        { kind: "snapshot", snapshotKey: "home__ios-390x844", maxMismatch: 0.5 },
        "expected: snapshot home__ios-390x844 (max 0.5% mismatch)",
      ],
    ] as const;

    for (const [expected, line] of arms) {
      const rendered = texts(
        await flowRunToMcpContent({
          flow: "f",
          ok: false,
          steps: [
            {
              index: 0,
              kind: "assert",
              status: "fail",
              failure: wireFailure({ code: "selector-not-found", message: "nope", expected }),
            },
          ],
        })
      ).join("\n");
      expect(rendered).toContain(line);
    }
  });

  it("omits a bare gesture expectation that only restates the step kind", async () => {
    const rendered = texts(
      await flowRunToMcpContent({
        flow: "f",
        ok: false,
        steps: [
          {
            index: 0,
            kind: "tap",
            status: "fail",
            failure: wireFailure({
              code: "selector-not-found",
              message: "nope",
              expected: { kind: "gesture", gesture: "tap" },
            }),
          },
        ],
      })
    ).join("\n");
    expect(rendered).not.toContain("expected:");
  });

  it("shows the zero-area element that IS the selector-not-visible diagnosis", async () => {
    // `invisibleMatches` was absent from the MCP wire type entirely, so the one
    // failure shape whose fix is "find out why it has no size" reached the
    // agent with no element at all — and its candidate list is deliberately
    // empty, because no other element was meant.
    const rendered = texts(
      await flowRunToMcpContent({
        flow: "f",
        ok: false,
        steps: [
          {
            index: 0,
            kind: "tap",
            status: "fail",
            failure: wireFailure({
              code: "selector-not-visible",
              message: 'element matched id="cta" but its frame has zero area',
              candidates: [],
              actual: {
                matchCount: 1,
                visibleMatchCount: 0,
                invisibleMatches: [
                  {
                    role: "button",
                    label: "Check out",
                    identifier: "cta",
                    frame: { x: 0.5, y: 0.5, width: 0, height: 0 },
                  },
                ],
              },
            }),
          },
        ],
      })
    ).join("\n");
    // `hidden` is the WHOLE diagnosis for this shape, and it used to be the one
    // marker the MCP row dropped — leaving a confident tap centre beside an
    // element with no area. The CLI derives all three states from the frame;
    // this row now derives them the same way.
    expect(rendered).toContain('match: "Check out"  button  id=cta  hidden  at 0.50, 0.50');
  });

  it("inlines NO snapshot image when the run typed a secret", async () => {
    // The producer declines `failure.screenshot` on a secret run because pixels
    // are never scrubbed — but a snapshot step registers `current` (and
    // `diff`) itself, independently of the failure diagnostics. Inlining
    // either one hands the agent the same screen as an image and defeats the
    // omission entirely.
    const withSecret = (artifacts: Record<string, unknown>): FlowExecuteResult => ({
      flow: "visual",
      ok: false,
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "fail",
          target: '"home"',
          reason: "no baseline for home",
          artifacts,
          failure: wireFailure({
            code: "snapshot-baseline-missing",
            message: "no baseline for home",
            data: { platform: "chromium", screenshotOmitted: "secret-typed" },
          }),
        },
      ],
    });

    for (const artifacts of [
      { current: artifactHandle("cur2", "home-current.png", "image/png") },
      { diff: artifactHandle("dif2", "home-diff.png", "image/png") },
    ]) {
      const blocks = await flowRunToMcpContent(withSecret(artifacts), {
        toolsUrl: "http://remote:3001",
        fetchImpl: fetchReturning([...PNG_SIGNATURE]) as unknown as typeof fetch,
      });
      expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
      // The PATH still prints — the operator can open it deliberately; what
      // must not happen is the pixels landing in the model's context.
      expect(texts(blocks).join("\n")).toMatch(/home-(current|diff)\.png/);
    }
  });

  it("renders a snapshot failure's image once, under its own role", async () => {
    // `failure.screenshot` on a snapshot failure IS the step's `current`: the
    // producer reuses the handle rather than capturing a second time. Rendering
    // it again listed one image under two different path strings and spent the
    // run's single inlined image on a picture already on screen.
    const current = artifactHandle("cur1", "home-current.png", "image/png");
    const input: FlowExecuteResult = {
      flow: "visual",
      ok: false,
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "fail",
          target: '"home"',
          reason: "no baseline for home",
          // The three shapes that carry `current` and no `diff`.
          artifacts: { current },
          failure: wireFailure({
            code: "snapshot-baseline-missing",
            message: "no baseline for home",
            screenshot: { ...current },
          }),
        },
      ],
    };

    const rendered = texts(await flowRunToMcpContent(input)).join("\n");

    // Named once, by the role that owns it.
    expect(rendered).toContain("current: home-current.png");
    expect(rendered).not.toContain("screenshot: home-current.png");
    expect(rendered.match(/home-current\.png/g)).toHaveLength(1);
  });

  it("inlines `current` when the snapshot shape produced no diff", async () => {
    // `inlineRole` is the headline change to this renderer and nothing reached
    // it: the two near-miss tests set `secretTyped` (which kills the `failed`
    // flag it is gated behind) and pass no ctx respectively, so deleting the
    // line left the suite green.
    //
    // Three snapshot shapes produce no `diff` at all — baseline-missing,
    // dimension-mismatch, crop-empty — and `current` is then the only picture
    // of what failed. Beside its own path, which is what lets the failure block
    // stop re-rendering the same image under a second, materialized one.
    const fetchImpl = vi.fn(fetchReturning([...PNG_SIGNATURE, 0x42]));
    const input: FlowExecuteResult = {
      flow: "visual",
      ok: false,
      failed: 1,
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "fail",
          target: '"home"',
          reason: "no baseline for home",
          artifacts: {
            baseline: artifactHandle("base3", "home-baseline.png", "image/png"),
            current: artifactHandle("cur3", "home-current.png", "image/png"),
          },
        },
      ],
    };

    const blocks = await flowRunToMcpContent(input, {
      toolsUrl: "http://remote:3001",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
    // `current`, and ONLY current: `baseline` is a full-res PNG nobody renders,
    // so its handle prints as a path without pulling the bytes.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/artifacts/cur3");
  });

  it("prefers the annotated diff over `current` when both are present", async () => {
    // The other side of `inlineRole`: the diff boxes the changed pixels, so it
    // is strictly the more informative of the two.
    const fetchImpl = vi.fn(fetchReturning([...PNG_SIGNATURE, 0x43]));
    const input: FlowExecuteResult = {
      flow: "visual",
      ok: false,
      failed: 1,
      steps: [
        {
          index: 0,
          kind: "snapshot",
          status: "fail",
          target: '"home"',
          reason: "diff 3.10% > 0.5%",
          artifacts: {
            current: artifactHandle("cur4", "home-current.png", "image/png"),
            diff: artifactHandle("dif4", "home-diff.png", "image/png"),
          },
        },
      ],
    };

    const blocks = await flowRunToMcpContent(input, {
      toolsUrl: "http://remote:3001",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/artifacts/dif4");
  });

  it("truncates at MAX_RENDER_FAILURES and says how many were dropped", async () => {
    // The largest fixture here had two failures, so the cap was never reached.
    // An honest server sends exactly one (the runner hard-stops at the first
    // non-passing leaf), so this only bites a buggy or hostile one — where an
    // unbounded loop over budget-respecting blocks is a half-gigabyte result.
    const input: FlowExecuteResult = {
      flow: "hostile",
      ok: false,
      steps: Array.from({ length: 12 }, (_, i) => ({
        index: i,
        kind: "tap",
        status: "fail" as const,
        target: `"btn-${i}"`,
        failure: wireFailure({ code: "selector-not-found", message: `miss ${i}` }),
      })),
    };

    const rendered = texts(await flowRunToMcpContent(input)).join("\n");

    // Blocks stop well before the twelfth...
    expect(rendered).toContain("miss 0");
    expect(rendered).not.toContain("miss 11");
    // ...and the trailing count covers every failure not rendered.
    expect(rendered).toContain("more failures");
  });

  it("tells the agent NOT to screenshot a screen a secret was typed onto", async () => {
    // The producer declines the capture because pixels are never scrubbed. An
    // agent that just saw a missing image would call `screenshot` itself and
    // pull the credential into its own context — so the omission has to carry
    // its instruction with it. The wording says "onto this device", not "by
    // this run": the producer's guard is device-scoped, so the run being
    // rendered need not be the one that typed the value.
    const input: FlowExecuteResult = {
      flow: "login",
      ok: false,
      steps: [
        {
          index: 0,
          kind: "assert",
          status: "fail",
          target: "visible id=order-confirmation",
          failure: wireFailure({
            code: "selector-not-found",
            message: 'no element matched selector id="order-confirmation"',
            screen: { state: "available", source: "chromium", elementCount: 3 },
            data: { platform: "chromium", screenshotOmitted: "secret-typed" },
          }),
        },
      ],
    };

    const rendered = texts(await flowRunToMcpContent(input)).join("\n");

    expect(rendered).toContain(
      "screenshot: omitted — a {{secret:…}} value was typed onto this device"
    );
    expect(rendered).toContain("Do NOT call `screenshot` here");
  });

  it("tells the agent a composition failure has no screen of its own", async () => {
    // A cyclic `run:` is decided from the flow files, so nothing on the device
    // is evidence. Without the note the agent sees a missing image and takes
    // one itself — of an unrelated app, which it then reasons about.
    const input: FlowExecuteResult = {
      flow: "a",
      ok: false,
      steps: [
        {
          index: 0,
          kind: "run",
          status: "error",
          target: "./b.yaml",
          failure: wireFailure({
            code: "run-cyclic",
            message: "cyclic flow reference: a → b → a",
            screen: { state: "unavailable", reason: "never-readable" },
            data: { screenshotOmitted: "no-screen" },
          }),
        },
      ],
    };

    const rendered = texts(await flowRunToMcpContent(input)).join("\n");

    expect(rendered).toContain(
      "screenshot: omitted — this step failed before it reached the device"
    );
    expect(rendered).toContain("fix the flow file instead");
  });

  it("renders no screenshot line for an omission reason it has never heard of", async () => {
    const input: FlowExecuteResult = {
      flow: "a",
      ok: false,
      steps: [
        {
          index: 0,
          kind: "assert",
          status: "fail",
          failure: wireFailure({
            code: "selector-not-found",
            message: "no element matched",
            screen: { state: "unavailable", reason: "never-readable" },
            data: { screenshotOmitted: "some-future-reason" },
          }),
        },
      ],
    };

    const rendered = texts(await flowRunToMcpContent(input)).join("\n");

    expect(rendered).not.toContain("screenshot:");
  });

  it("clamps hostile wire data instead of throwing or blowing up the block", async () => {
    const huge = "x".repeat(1_000_000);
    const input: FlowExecuteResult = {
      flow: "hostile",
      ok: false,
      steps: [
        {
          index: 0,
          kind: "tap",
          status: "fail",
          target: '"A"',
          durationMs: Number.NaN,
          failure: wireFailure({
            code: "a-code-this-build-has-never-heard-of",
            determinacy: "who knows",
            message: huge,
            hint: 42,
            candidates: [
              ...Array.from({ length: 10_000 }, () => ({
                node: { label: huge, frame: { x: Number.NaN, y: 1, width: 1, height: 1 } },
                score: Number.NaN,
              })),
            ],
            candidateCount: "lots",
            screen: { state: "available", elementCount: Number.POSITIVE_INFINITY, source: 7 },
            screenshot: { nope: true },
            tree: 12345,
            cause: "not an object",
          }),
        },
      ],
    };

    const blocks = await flowRunToMcpContent(input);
    const block = texts(blocks).find((t) => t.startsWith("  1) tap"))!;
    const lines = block.split("\n");

    // A NaN duration renders no duration at all rather than "(NaNs)".
    expect(lines[0]).toBe('  1) tap "A"');
    // Unknown code renders generically, message truncated to the display cap.
    expect(lines[1]!.startsWith("     a-code-this-build-has-never-heard-of: xxx")).toBe(true);
    expect(lines[1]!.length).toBeLessThan(400);
    // "who knows" is not "indeterminate" — no framing line.
    expect(block).not.toContain("argent could not see the screen");
    // 10 000 candidates clamp to 5; a NaN score renders as "?" and a NaN frame
    // drops the tap centre rather than emitting "at NaN, NaN".
    const candidates = lines.filter((l) => l.startsWith("       "));
    expect(candidates).toHaveLength(5);
    expect(candidates[0]!.startsWith("       ?  ")).toBe(true);
    expect(block).not.toContain("NaN");
    // Non-strings are ignored: no hint, no cause, no screenshot/tree lines, and
    // an infinite element count contributes no "screen:" line.
    expect(block).not.toContain("hint:");
    expect(block).not.toContain("cause:");
    expect(block).not.toContain("screenshot:");
    expect(block).not.toContain("tree:");
    expect(block).not.toContain("screen:");
  });

  it("renders no failure block for a failure a hostile server hung on narration", async () => {
    // Echo takes no step number, so a `failure` on one — which the runner never
    // produces, since echo only passes or skips — would head its block with the
    // previous step's number, or with 0 before any real step has run. The CLI
    // drops them for the same reason.
    const input: FlowExecuteResult = {
      flow: "hostile",
      ok: false,
      steps: [
        {
          index: 0,
          kind: "echo",
          status: "pass",
          message: "narration",
          failure: wireFailure({ code: "selector-not-found", message: "impossible" }),
        },
      ],
    };

    const rendered = texts(await flowRunToMcpContent(input)).join("\n");

    expect(rendered).toContain("› ✓ narration");
    expect(rendered).not.toContain("Failures:");
    expect(rendered).not.toContain("0)");
  });

  it("pins the whole failure block, line for line", async () => {
    // Every other assertion in this section is `toContain`, so an injected
    // extra line — or a slot silently dropped — survives the suite. One
    // verbatim pin is what makes the block a contract rather than a bag of
    // substrings; the CLI's own renderer has had one from the start.
    const input: FlowExecuteResult = {
      flow: "checkout",
      device: "SIM-1",
      ok: false,
      passed: 1,
      failed: 1,
      steps: [
        { index: 0, kind: "launch", status: "pass", target: "com.acme.shop", durationMs: 3100 },
        {
          index: 1,
          kind: "tap",
          status: "fail",
          target: '"Checkout"',
          durationMs: 5002,
          reason: 'no visible element matched selector text="Checkout"',
          failure: wireFailure({
            code: "selector-not-found",
            message: 'no visible element matched selector text="Checkout"',
            determinacy: "determinate",
            hint: "the closest match differs only by a space",
            step: { index: 1, ordinal: 2, kind: "tap", flow: "checkout" },
            expected: { kind: "condition", condition: "visible", timeoutMs: 5000 },
            screen: {
              state: "available",
              source: "native-devtools",
              capturedAt: "at-failure",
              elementCount: 47,
              size: { width: 390, height: 844 },
            },
            candidates: [
              {
                score: 0.86,
                basis: "text-near",
                selectorYaml: "{ id: checkout-cta }",
                node: {
                  role: "button",
                  label: "Check out",
                  identifier: "checkout-cta",
                  frame: { x: 0.4, y: 0.84, width: 0.2, height: 0.04 },
                },
              },
            ],
            candidateCount: 1,
            cause: { code: "NATIVE_DEVTOOLS_NOT_CONNECTED", message: "socket closed" },
            tree: "/srv/step-02-tree.txt",
          }),
        },
      ],
    };

    const blocks = texts(await flowRunToMcpContent(input));

    expect(blocks[blocks.length - 1]).toBe(
      [
        '  2) tap "Checkout" (5.0s)',
        '     selector-not-found: no visible element matched selector text="Checkout"',
        "     expected: visible",
        '     candidates (1, ranked; "at" is the normalized tap centre — verify by tapping it):',
        '       0.86  "Check out"  button  id=checkout-cta  visible  at 0.50, 0.86  (text-near)  → { id: checkout-cta }',
        "     screen: 47 elements, 390x844, captured at the failure, via native-devtools",
        "     hint: the closest match differs only by a space",
        "     cause: NATIVE_DEVTOOLS_NOT_CONNECTED: socket closed",
        "     tree: /srv/step-02-tree.txt (read this file for the full element list)",
      ].join("\n")
    );
  });

  it("numbers the failure block the way every other surface numbers it", async () => {
    // The block heading used to be the raw array position, so any flow with an
    // `echo:` before the failing step disagreed with the CLI, with the
    // `step-NN-*` export filenames, and with the `failure.step.ordinal` the
    // server puts on the wire — and a leading echo is the idiom the skill docs
    // prescribe, so this was the common case.
    const input: FlowExecuteResult = {
      flow: "echofail",
      ok: false,
      steps: [
        { index: 0, kind: "launch", status: "pass", target: "com.acme.shop" },
        { index: 1, kind: "echo", status: "pass", message: "now looking for the button" },
        {
          index: 2,
          kind: "tap",
          status: "fail",
          target: "id=Dictat",
          failure: wireFailure({
            code: "selector-not-found",
            message: 'no visible element matched selector id="Dictat"',
            // The wire's own ordinal: the number the CLI and the export agree on.
            step: { index: 2, ordinal: 2, kind: "tap", flow: "echofail" },
            screen: { state: "unavailable", reason: "read-failed" },
          }),
        },
      ],
    };

    const rendered = texts(await flowRunToMcpContent(input)).join("\n");

    // The step list and the block heading, in lockstep and both at 2.
    expect(rendered).toContain("[2] ✗ tap id=Dictat");
    expect(rendered).toContain("  2) tap id=Dictat");
    expect(rendered).not.toContain("[3]");
    expect(rendered).not.toContain("  3)");
  });

  it("renders a report with no failure exactly as it does today", async () => {
    const input: FlowExecuteResult = {
      flow: "legacy",
      device: "SIM",
      ok: false,
      passed: 1,
      failed: 1,
      errored: 0,
      skipped: 1,
      steps: [
        { index: 0, kind: "echo", status: "pass", message: "Opening the cart" },
        { index: 1, kind: "tap", status: "pass", target: '"Cart"' },
        {
          index: 2,
          kind: "snapshot",
          status: "fail",
          target: '"home"',
          reason: "diff 3.10% > 0.5% (home)",
          artifacts: { baseline: "/srv/b.png" },
        },
        { index: 3, kind: "assert", status: "skip", target: '"Order placed"' },
      ],
    };

    // Pinned verbatim: an old tool-server sends no `failure`/`durationMs`, and
    // every slot of its output is fixed here.
    //
    // The numbers changed with the echo fix, and this fixture is why the defect
    // survived: it PINNED the wrong ones. The snapshot is step 2 of this run —
    // that is what `summarize` counts, what `failure.step.ordinal` carries,
    // what the CLI prints, and what the `step-NN-*` export filenames say.
    expect(await flowRunToMcpContent(input)).toEqual([
      { type: "text", text: 'Running flow "legacy" on SIM (4 steps)' },
      { type: "text", text: "› ✓ Opening the cart" },
      { type: "text", text: '[1] ✓ tap "Cart"' },
      { type: "text", text: '[2] ✗ snapshot "home" — diff 3.10% > 0.5% (home)' },
      { type: "text", text: "  baseline: /srv/b.png" },
      { type: "text", text: '[3] · assert "Order placed"' },
      { type: "text", text: "FAIL — 1 passed, 1 failed, 0 errored, 1 skipped" },
    ]);
  });
});
