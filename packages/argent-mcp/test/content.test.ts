import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  toMcpContent,
  describeResultText,
  screenshotPathNote,
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
    expect(result).toEqual([{ type: "text", text: JSON.stringify({ foo: "bar" }) }]);
  });

  it("returns a string result as-is, not as a JSON-quoted line", async () => {
    const report = 'Screen: 402x874\n\nView "Home" (tap: 0.12,0.93)';
    expect(await toMcpContent(report)).toEqual([{ type: "text", text: report }]);
  });

  it("writes control characters in a string result as visible escapes", async () => {
    const result = await toMcpContent("a\u001b[0m\tb\r\nc\u0000");
    expect(result).toEqual([{ type: "text", text: "a\\u001b[0m\tb\r\nc\\u0000" }]);
  });

  it("writes object results without indentation", async () => {
    const value = { a: { b: [1, 2] }, c: null };
    const result = await toMcpContent(value);
    expect(result).toEqual([{ type: "text", text: '{"a":{"b":[1,2]},"c":null}' }]);
  });

  it("keeps a top-level list of strings one item per line, as valid JSON", async () => {
    const value = { message: "saved", summary: ["1. tap", "  warning: late"], steps: 1 };
    const [block] = await toMcpContent(value);
    const text = (block as { text: string }).text;
    expect(text).toBe('{"message":"saved","summary":[\n"1. tap",\n"  warning: late"\n],"steps":1}');
    expect(JSON.parse(text)).toEqual(value);
  });

  it("leaves other lists on one line", async () => {
    const value = { one: ["x"], numbers: [1, 2], nested: { list: ["a", "b"] }, none: [] };
    const result = await toMcpContent(value);
    expect(result).toEqual([{ type: "text", text: JSON.stringify(value) }]);
  });

  it("returns an empty string result as a visible empty string", async () => {
    expect(await toMcpContent("")).toEqual([{ type: "text", text: '""' }]);
  });

  it("returns JSON text block when outputHint is not image", async () => {
    const result = await toMcpContent({ url: "http://x" }, "other");
    expect(result).toEqual([
      {
        type: "text",
        text: JSON.stringify({ url: "http://x" }),
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

  it.each([
    ["image-and-path", ["image", "Saved: /tmp/img.png"]],
    ["image", ["image"]],
    ["path", [screenshotPathNote("/tmp/img.png")]],
  ] as const)("renders a screenshot in the %s form", async (form, expected) => {
    vi.stubGlobal("fetch", mockOk(PNG_SIGNATURE));

    const result = await toMcpContent(
      { url: "http://localhost/img.png", path: "/tmp/img.png" },
      "image",
      undefined,
      undefined,
      form
    );

    expect(result.map((b) => (b.type === "image" ? "image" : b.text))).toEqual(expected);
    vi.unstubAllGlobals();
  });

  it("keeps the plain Saved line when the agent asked for no image, in every form", async () => {
    const result = await toMcpContent(
      { url: "http://localhost/img.png", path: "/tmp/img.png" },
      "image",
      undefined,
      { includeImageInContext: false },
      "path"
    );

    expect(result).toEqual([{ type: "text", text: "Saved: /tmp/img.png" }]);
  });

  it("uses empty string for path when not present", async () => {
    vi.stubGlobal("fetch", mockOk(PNG_SIGNATURE));

    const result = await toMcpContent({ url: "http://x" }, "image");
    expect(result[1]).toEqual({ type: "text", text: "Saved: " });

    vi.unstubAllGlobals();
  });

  it("falls back to text when outputHint is image but no url", async () => {
    const result = await toMcpContent({ foo: 1 }, "image");
    expect(result).toEqual([{ type: "text", text: JSON.stringify({ foo: 1 }) }]);
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
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-mcp-content-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns a context image, the summary text, then the diff paths it refers to", async () => {
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
      {
        type: "text",
        text: `diffPath: ${path.join(dir, "full.diff.png")}\ncontextDiffPath: ${contextDiffPath}`,
      },
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

  it("lists raw host paths and attaches no image in the path form", async () => {
    const contextDiffPath = path.join(dir, "context.diff.png");
    await fs.writeFile(contextDiffPath, Buffer.from(PNG_SIGNATURE));
    const diffPath = path.join(dir, "full.diff.png");

    const content = await screenshotDiffToMcpContent(
      { summary: "see diffPath", diffPath, contextDiffPath },
      undefined,
      "path"
    );

    expect(content).toEqual([
      { type: "text", text: "see diffPath" },
      { type: "text", text: `diffPath: ${diffPath}\ncontextDiffPath: ${contextDiffPath}` },
    ]);
  });

  describe("with artifact handles", () => {
    const ctx = { toolsUrl: "http://127.0.0.1:1", authToken: "token", deviceId: "DEV-1" };
    const pngBytes = Buffer.from(PNG_SIGNATURE);

    // `materializeArtifacts` uses `hostPath` only for a file of this exact size and mtime.
    async function handleFor(id: string): Promise<{ file: string; handle: ArtifactHandle }> {
      const file = path.join(dir, `${id}.png`);
      await fs.writeFile(file, pngBytes);
      const { size, mtimeMs } = await fs.stat(file);
      return {
        file,
        handle: {
          [ARTIFACT_MARKER]: true,
          id,
          filename: `${id}.png`,
          kind: "screenshot-diff",
          mimeType: "image/png",
          size,
          mtimeMs,
          hostPath: file,
        },
      };
    }

    it("lists the materialized paths and attaches the context image", async () => {
      const diff = await handleFor("full");
      const context = await handleFor("context");

      const content = await screenshotDiffToMcpContent(
        { summary: "see diffPath", diffPath: diff.handle, contextDiffPath: context.handle },
        ctx
      );

      expect(content).toEqual([
        { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" },
        { type: "text", text: "see diffPath" },
        { type: "text", text: `diffPath: ${diff.file}\ncontextDiffPath: ${context.file}` },
      ]);
    });

    it("lists the materialized paths and attaches no image in the path form", async () => {
      const diff = await handleFor("full");
      const context = await handleFor("context");

      const content = await screenshotDiffToMcpContent(
        { summary: "see diffPath", diffPath: diff.handle, contextDiffPath: context.handle },
        ctx,
        "path"
      );

      expect(content).toEqual([
        { type: "text", text: "see diffPath" },
        { type: "text", text: `diffPath: ${diff.file}\ncontextDiffPath: ${context.file}` },
      ]);
    });

    // The summary still says "see diffPath … in this result".
    it("says a diff could not be fetched, and leaves out a diff the result never had", async () => {
      const notFound = {
        ...ctx,
        fetchImpl: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
      };
      const remote = (id: string) => artifactHandle(id, `${id}.png`, "image/png");

      const both = await screenshotDiffToMcpContent(
        { summary: "see diffPath", diffPath: remote("full"), contextDiffPath: remote("context") },
        notFound
      );
      expect(both).toEqual([
        { type: "text", text: "see diffPath" },
        { type: "text", text: "diffPath: (unavailable)\ncontextDiffPath: (unavailable)" },
      ]);

      const one = await screenshotDiffToMcpContent(
        { summary: "see diffPath", diffPath: remote("full") },
        notFound,
        "path"
      );
      expect(one).toEqual([
        { type: "text", text: "see diffPath" },
        { type: "text", text: "diffPath: (unavailable)" },
      ]);
    });
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

  it("renders an image artifact as its path only in the path form", async () => {
    const result = await toMcpContent(
      { image: artifactHandle("img1", "shot.png", "image/png") },
      "image",
      {
        toolsUrl: "http://remote:3001",
        deviceId: "DEV-1",
        fetchImpl: fetchReturning([...PNG_SIGNATURE]),
      },
      undefined,
      "path"
    );

    expect(result).toHaveLength(1);
    expect((result[0] as { text: string }).text).toMatch(/^Screenshot saved to .*shot\.png\n/);
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

  // The renderer's half of the one-observation guarantee; the allow-list half
  // is tool-server's run-sequence-observation-gate.test.ts. The result is
  // walked whole, steps included, and every artifact handle found becomes its
  // own image block — so a sequence holds at one frame only while its steps
  // report none.
  it("renders a multi-step sequence result without a frame of its own", async () => {
    // A fetch that resolves. Left to the global one, a step-carried handle
    // would fail to download and be swallowed, so the assertions below would
    // hold just as well for a sequence whose frames were merely unreachable.
    const fetchImpl = vi.fn(fetchReturning([...PNG_SIGNATURE, 0x42]));

    const result = await toMcpContent(
      {
        completed: 3,
        total: 3,
        steps: [
          { tool: "gesture-swipe", result: { swiped: true, timestampMs: 1 } },
          { tool: "keyboard", result: { typed: "hello", keys: 0 } },
          { tool: "gesture-tap", result: { tapped: true, timestampMs: 2 } },
        ],
      },
      undefined,
      { toolsUrl: "http://remote:3001", deviceId: "DEV-1", fetchImpl }
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.filter((b) => b.type === "image")).toEqual([]);
    expect(result).toHaveLength(1);
    expect((result[0] as { text: string }).text).toContain("gesture-tap");
  });

  it("materializes an artifact handle carried on a step result", async () => {
    // Keeps the pin above honest: the walk really does reach steps[].result,
    // so a step tool that returned a frame would be inlined mid-sequence.
    const pngBytes = [...PNG_SIGNATURE, 0x42];
    const result = await toMcpContent(
      {
        completed: 1,
        total: 1,
        steps: [
          { tool: "gesture-tap", result: { image: artifactHandle("s0", "shot.png", "image/png") } },
        ],
      },
      undefined,
      { toolsUrl: "http://remote:3001", deviceId: "DEV-1", fetchImpl: fetchReturning(pngBytes) }
    );

    expect(result.filter((b) => b.type === "image")).toEqual([
      { type: "image", data: Buffer.from(pngBytes).toString("base64"), mimeType: "image/png" },
    ]);
  });

  it.each([
    ["the default form", undefined, ["text", "image"]],
    ["the path form", "path", ["text"]],
  ] as const)("handles an image riding on a non-image result in %s", async (_, form, types) => {
    const result = await toMcpContent(
      { frame: artifactHandle("f1", "frame.png", "image/png") },
      undefined,
      {
        toolsUrl: "http://remote:3001",
        deviceId: "DEV-1",
        fetchImpl: fetchReturning([...PNG_SIGNATURE, 0x42]),
      },
      undefined,
      form
    );

    expect(result.map((b) => b.type)).toEqual(types);
    expect((result[0] as { text: string }).text).toContain("frame.png");
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
  // The failure cases below drive the real materializeArtifacts, which writes
  // under artifactsRoot() — tmpdir()/argent-artifacts unless pinned, a path no
  // test would then own or remove.
  let root: string;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    root = await mkdtemp(join(tmpdir(), "content-flow-artifacts-"));
    process.env.ARGENT_ARTIFACTS_DIR = root;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.ARGENT_ARTIFACTS_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("names the same-named test a run's test hides, under the header", async () => {
    const warning =
      "/p/.argent/flows/f.yaml is not used: /p/.argent/e2e/f.yaml has the same name and is read first.";
    const blocks = await flowRunToMcpContent({ flow: "f", steps: [], warning });

    expect(blocks.slice(0, 2)).toEqual([
      { type: "text", text: 'Running e2e test "f" (0 steps)' },
      { type: "text", text: `⚠ ${warning}` },
    ]);
  });

  it("names each baseline a run over a link returned but could not write", async () => {
    const blocks = await flowRunToMcpContent({
      flow: "f",
      steps: [],
      baselineWrites: ["/p/a.png", { path: "/p/b.png", error: "EACCES: permission denied" }],
    });

    expect(blocks).toContainEqual({
      type: "text",
      text: "✗ baseline not written: /p/b.png: EACCES: permission denied",
    });
  });

  it("names the e2e test from e2eTest, falling back to the flow an older tool-server sends", async () => {
    const texts = async (input: FlowExecuteResult) =>
      (await flowRunToMcpContent(input)).map((b) => (b.type === "text" ? b.text : ""));
    expect(await texts({ e2eTest: "new", flow: "old", steps: [] })).toEqual([
      'Running e2e test "new" (0 steps)',
      'E2E test "new" complete.',
    ]);
    expect(await texts({ e2eTest: "new", steps: [] })).toEqual([
      'Running e2e test "new" (0 steps)',
      'E2E test "new" complete.',
    ]);
    expect(await texts({ flow: "old", steps: [] })).toEqual([
      'Running e2e test "old" (0 steps)',
      'E2E test "old" complete.',
    ]);
  });

  it("produces header and footer text blocks", async () => {
    const input: FlowExecuteResult = { flow: "test", steps: [] };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks[0]).toEqual({
      type: "text",
      text: 'Running e2e test "test" (0 steps)',
    });
    expect(blocks[blocks.length - 1]).toEqual({
      type: "text",
      text: 'E2E test "test" complete.',
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

  it("renders a script step's captured output as its own block", async () => {
    const input: FlowExecuteResult = {
      flow: "f",
      steps: [
        {
          index: 0,
          kind: "script",
          status: "pass",
          target: "scripts/seed.mjs",
          scriptLog: "creating order\norder 4711 created\n",
        },
      ],
    };
    const blocks = await flowRunToMcpContent(input);

    expect(blocks[1]).toEqual({ type: "text", text: "[1] ✓ script scripts/seed.mjs" });
    expect(blocks[2]).toEqual({
      type: "text",
      text: "script output:\ncreating order\norder 4711 created",
    });
  });

  it("indents a nested script step's output block with its step line", async () => {
    const blocks = await flowRunToMcpContent({
      flow: "f",
      steps: [
        { index: 0, kind: "run", status: "pass", target: "seed.yaml" },
        {
          index: 1,
          kind: "script",
          status: "pass",
          target: "scripts/seed.mjs",
          depth: 1,
          scriptLog: "creating order\n",
          scriptLogTruncated: true,
        },
      ],
    });

    expect(blocks[2]).toEqual({ type: "text", text: "[2] ✓   script scripts/seed.mjs" });
    expect(blocks[3]).toEqual({
      type: "text",
      text: "  script output:\ncreating order\n… output truncated",
    });
  });

  it("says when a script's log was truncated, and ignores a non-string one off the wire", async () => {
    const truncated = await flowRunToMcpContent({
      flow: "f",
      steps: [
        { index: 0, kind: "script", status: "fail", scriptLog: "…", scriptLogTruncated: true },
      ],
    });
    expect(JSON.stringify(truncated)).toContain("output truncated");

    const nothingLeft = await flowRunToMcpContent({
      flow: "f",
      steps: [{ index: 0, kind: "script", status: "pass", scriptLogTruncated: true }],
    });
    expect(nothingLeft[2]).toEqual({
      type: "text",
      text: "script output:\n… output truncated",
    });

    const hostile = await flowRunToMcpContent({
      flow: "f",
      steps: [
        {
          index: 0,
          kind: "script",
          status: "pass",
          scriptLog: { evil: true } as unknown as string,
        },
      ],
    });
    expect(hostile.filter((b) => b.type === "text")).toHaveLength(3); // header, step, footer
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
    expect(texts).toContain("[3] ✓     deep note");
    expect(texts).toContain('[4] ✓ tap "A"');
    const cap = "  ".repeat(20);
    expect(texts).toContain(`[5] ✓ ${cap}tap "B"`);
    expect(texts).toContain(`[6] ✓ ${cap}tap "C"`);
    expect(texts).toContain(`[7] ✓ ${cap}tap "D"`);
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

    expect(texts[0]).toBe('Running e2e test "checkout" on SIM (4 steps)');
    expect(texts[1]).toBe("[1] ✓ tap");
    expect(texts[2]).toBe("[2] ✓ assert");
    expect(texts[3]).toBe("[3] ✗ snapshot — diff 3.10% > 0.5% (home)");
    expect(texts[4]).toBe("[4] · done");
    expect(texts[texts.length - 1]).toBe("FAIL — 2 passed, 1 failed, 0 errored, 1 skipped");
    // No invalid (text: undefined) blocks even though directive steps carry no result.
    expect(blocks.every((b) => b.type !== "text" || typeof b.text === "string")).toBe(true);
  });

  it("puts each step's time before its reason and the run time on the verdict", async () => {
    const input: FlowExecuteResult = {
      flow: "checkout",
      device: "SIM",
      ok: false,
      passed: 1,
      failed: 1,
      errored: 0,
      skipped: 1,
      durationMs: 92_400,
      steps: [
        { index: 0, kind: "echo", status: "pass", message: "opening", durationMs: 0 },
        { index: 1, kind: "launch", status: "pass", target: "com.acme.shop", durationMs: 3100 },
        {
          index: 2,
          kind: "tap",
          status: "fail",
          target: '"Checkout"',
          reason: "no match",
          warning: "moving",
          depth: 1,
          durationMs: 5002,
        },
        { index: 3, kind: "await", status: "skip", target: 'visible "Done"' },
        { index: 4, kind: "tap", status: "pass", durationMs: -1 },
      ],
    };
    const texts = (await flowRunToMcpContent(input))
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    expect(texts.slice(1)).toEqual([
      "[1] ✓ opening",
      "[2] ✓ launch com.acme.shop (3.1s)",
      '[3] ✗   tap "Checkout" (5.0s) — no match ⚠ moving',
      '[4] · await visible "Done"',
      "[5] ✓ tap",
      "FAIL — 1 passed, 1 failed, 0 errored, 1 skipped (1m 32s)",
    ]);
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
    // Under the pinned root, not artifactsRoot()'s shared default.
    expect(artifactText?.text).toContain(`diff: ${root}`);
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

  it.each([
    ["the default form", undefined, 1],
    ["the path form", "path", 0],
  ] as const)("renders a failed snapshot's diff in %s", async (_, form, imageCount) => {
    const blocks = await flowRunToMcpContent(
      {
        flow: "checkout",
        steps: [
          {
            index: 0,
            kind: "snapshot",
            status: "fail",
            artifacts: { diff: artifactHandle("d1", "home-diff.png", "image/png") },
          },
        ],
      },
      { toolsUrl: "http://remote:3001", fetchImpl: fetchReturning([...PNG_SIGNATURE, 0x02]) },
      form
    );

    const texts = blocks.flatMap((b) => (b.type === "text" ? [b.text] : []));
    expect(texts.join("\n")).toContain(`diff: ${root}`);
    expect(texts.join("\n")).toMatch(/diff: .*home-diff\.png/);
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(imageCount);
  });

  it("renders a screenshot step as its path note in the path form", async () => {
    vi.stubGlobal("fetch", mockOk([...PNG_SIGNATURE, 0x01]));

    const blocks = await flowRunToMcpContent(
      {
        flow: "f",
        steps: [
          {
            kind: "tool",
            tool: "screenshot",
            result: { url: "http://localhost/img.png", path: "/tmp/s.png" },
            outputHint: "image",
          },
        ],
      },
      undefined,
      "path"
    );

    expect(blocks[2]).toEqual({ type: "text", text: screenshotPathNote("/tmp/s.png") });
    expect(blocks.filter((b) => b.type === "image")).toEqual([]);

    vi.unstubAllGlobals();
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
      text: JSON.stringify({ ok: true }),
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

    expect(texts[0]).toContain("Running e2e test");
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

// ── describeResultText ───────────────────────────────────────────────

describe("describeResultText", () => {
  const header = "Source: ax-service\nMode: flat\n\nROOT  AXGroup (0, 0, 1, 1)\n\n";
  const tree = `${header}  AXButton "Done"  (0.1, 0.2, 0.3, 0.1)`;
  const sent = `${header}AXButton "Done" (0.1, 0.2, 0.3, 0.1)`;

  it("drops the indent every row shares and keeps the depth between rows", () => {
    const rows = [
      '  Button "Close" [clickable]  (0.000, 0.000, 1.000, 1.000)',
      '    Button "Open" id="menu"  (0.039, 0.032, 0.073, 0.036)',
      '      Text "Title"  (-0.100, 0.000, 0.500, 0.100)',
      '  Text "Back"  (0.000, 0.900, 0.100, 0.100)',
    ].join("\n");
    expect(describeResultText({ description: `${header}${rows}`, source: "ax-service" })).toBe(
      header +
        [
          'Button "Close" [clickable] (0.000, 0.000, 1.000, 1.000)',
          '  Button "Open" id="menu" (0.039, 0.032, 0.073, 0.036)',
          '    Text "Title" (-0.100, 0.000, 0.500, 0.100)',
          'Text "Back" (0.000, 0.900, 0.100, 0.100)',
        ].join("\n")
    );
  });

  it("accepts the shorter frame form", () => {
    const description = `${header}  Button "Go"  (.040,.336,.920,.059)`;
    expect(describeResultText({ description, source: "ax-service" })).toBe(
      `${header}Button "Go" (.040,.336,.920,.059)`
    );
  });

  it("leaves a frame quoted in a label alone", () => {
    const description = `${header}  Text "a  (0, 0, 1, 1)"  (0.1, 0.2, 0.3, 0.1)`;
    expect(describeResultText({ description, source: "ax-service" })).toBe(
      `${header}Text "a  (0, 0, 1, 1)" (0.1, 0.2, 0.3, 0.1)`
    );
  });

  describe.each([
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
  ])("with %s in a label", (_, sep) => {
    const frame = "(0.1, 0.2, 0.3, 0.1)";

    it("treats the row like any other", () => {
      const rows = [
        `  textbox "a${sep}b"  ${frame}`,
        `    button "child"  ${frame}`,
        `  button "sibling"  ${frame}`,
      ].join("\n");
      expect(describeResultText({ description: `${header}${rows}`, source: "ax-service" })).toBe(
        header +
          [
            `textbox "a${sep}b" ${frame}`,
            `  button "child" ${frame}`,
            `button "sibling" ${frame}`,
          ].join("\n")
      );
    });

    it("keeps two spaces after the separator", () => {
      const description = `${header}  textbox "a${sep}  b"  ${frame}`;
      expect(describeResultText({ description, source: "ax-service" })).toBe(
        `${header}textbox "a${sep}  b" ${frame}`
      );
    });

    it("does not take a frame before the separator for the row's frame", () => {
      const description = `${header}  Text "a  (0, 0, 1, 1)${sep}b"  ${frame}`;
      expect(describeResultText({ description, source: "ax-service" })).toBe(
        `${header}Text "a  (0, 0, 1, 1)${sep}b" ${frame}`
      );
    });
  });

  it("leaves lines that are not tree rows alone", () => {
    const description = "  focused: Button Play\n  focusable: Button Stop\nNote:  (not a row)";
    expect(describeResultText({ description, source: "tv-focus" })).toBe(
      `${description}\nSource: tv-focus`
    );
  });

  // The TV focus view has no frames; its indent marks a focusable row.
  it("keeps a TV focus row whose label ends in a number in parentheses", () => {
    const description = [
      "App: com.x",
      "Focused: Home",
      "Focusable (3):",
      "→ Home",
      "  Top 10  (2024)",
      "  Movies [button]",
    ].join("\n");
    expect(describeResultText({ description, source: "tv-focus" })).toBe(
      `${description}\nSource: tv-focus`
    );
  });

  it("trims the rows of the tree Android TV falls back to", () => {
    const hint = "The Android TV focus engine reported no focusable elements.";
    const tvHeader = "Source: uiautomator\nMode: nested\n\nROOT  FrameLayout (0, 0, 1, 1)\n\n";
    const description = `${hint}\n\n${tvHeader}  Button "Season 2"  (0.1, 0.2, 0.3, 0.1)`;
    expect(describeResultText({ description, source: "uiautomator", hint })).toBe(
      `${hint}\n\n${tvHeader}Button "Season 2" (0.1, 0.2, 0.3, 0.1)`
    );
  });

  it("writes control characters as visible escapes, in the tree and after it", () => {
    const description = `${header}  button "Pay\u001b[31mRED\u0000now"  (0.1, 0.2, 0.3, 0.1)`;
    expect(describeResultText({ description, source: "ax-service", hint: "a\u0007b" })).toBe(
      `${header}button "Pay\\u001b[31mRED\\u0000now" (0.1, 0.2, 0.3, 0.1)\nHint: a\\u0007b`
    );
  });

  it("returns the tree as plain text, without repeating the source its header names", () => {
    expect(describeResultText({ description: tree, source: "ax-service" })).toBe(sent);
  });

  it("names the source when the tree does not", () => {
    expect(describeResultText({ description: "AXButton", source: "native-devtools" })).toBe(
      "AXButton\nSource: native-devtools"
    );
  });

  it("keeps should_restart and hint as lines after the tree", () => {
    expect(
      describeResultText({
        description: tree,
        source: "ax-service",
        should_restart: true,
        hint: "Restart the app.",
      })
    ).toBe(`${sent}\nshould_restart: true\nHint: Restart the app.`);
  });

  it("keeps unknown fields as JSON", () => {
    expect(describeResultText({ description: tree, source: "ax-service", extra: 1 })).toBe(
      `${sent}\n{"extra":1}`
    );
  });

  it("does not repeat a hint the tree text already carries", () => {
    const description = "Note: No element has focus.\nSource: tv-focus";
    expect(
      describeResultText({ description, source: "tv-focus", hint: "No element has focus." })
    ).toBe(description);
  });

  it("returns undefined for a result without a text tree", () => {
    expect(describeResultText({ tree: {} })).toBeUndefined();
    expect(describeResultText({ description: "" })).toBeUndefined();
    expect(describeResultText("text")).toBeUndefined();
    expect(describeResultText(null)).toBeUndefined();
  });
});
