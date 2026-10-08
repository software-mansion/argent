import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { ARTIFACT_MARKER, Registry, type ToolContext } from "@argent/registry";
import { createHttpApp, type HttpAppHandle } from "../../src/http";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import { screenshotDiffTool } from "../../src/tools/screenshot-diff";
import { redirectTmpdir } from "../helpers/tmpdir-env";

/**
 * A `tool: screenshot-diff` step of a flow uploaded over a link, end to end
 * through the HTTP layer: the REAL flow-execute and screenshot-diff on one real
 * registry, with a fake client that sends the PNGs on its own disk with the
 * flow file, as the members of its file input. Only the OCR pass of the diff,
 * a host binary, is stubbed.
 */

vi.mock("../../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({ updateInstallable: false, currentVersion: "1.0.0" })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

// The pixel diff stays real; its text pass would run tesseract where installed.
vi.mock("../../src/tools/screenshot-diff/text-diff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/screenshot-diff/text-diff")>()),
  analyzeScreenshotTextChanges: vi.fn(async () => ({
    status: "skipped",
    provider: "ocr",
    changes: [],
  })),
}));

// Every file-input resolution of the call is recorded with the server's
// (redirected) tmpdir as it is just before and just after its cleanup: the
// HTTP layer's for the uploaded flow and its members, and the step's for the
// files the client sent.
const h = vi.hoisted(() => ({
  serverTmp: "",
  cleanups: [] as Array<{ before: string[]; after: string[] }>,
}));
vi.mock("../../src/file-inputs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/file-inputs")>();
  return {
    ...actual,
    resolveFileInputs: vi.fn(async (...args: Parameters<typeof actual.resolveFileInputs>) => {
      const resolved = await actual.resolveFileInputs(...args);
      return {
        ...resolved,
        cleanup: async () => {
          const { readdir } = await import("node:fs/promises");
          const before = await readdir(h.serverTmp, { recursive: true });
          await resolved.cleanup();
          h.cleanups.push({ before, after: await readdir(h.serverTmp, { recursive: true }) });
        },
      };
    }),
  };
});

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
const ROOT_FLOW = "/client/flows/withdiff.yaml";
const BASE = "/client/shots/base.png";
const NOW = "/client/shots/now.png";
const FLOW_TEXT = serializeFlow({
  executionPrerequisite: "",
  steps: [
    { kind: "tool", name: "screenshot-diff", args: { baselinePath: BASE, currentPath: NOW } },
  ],
});

let workDir = "";
let baseBytes: Buffer;
let nowBytes: Buffer;
let restoreTmpdir: () => void = () => {};
let handle: HttpAppHandle | undefined = undefined;
let server: http.Server | undefined = undefined;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tool-step-files-over-link-"));
  // Two real PNGs of the same size: a 10x10 block below the status-bar band
  // differs, so the diff can only come out as it does from these two files.
  const base = new PNG({ width: 30, height: 60 });
  base.data.fill(200);
  baseBytes = PNG.sync.write(base);
  const now = new PNG({ width: 30, height: 60 });
  now.data.fill(200);
  for (let y = 30; y < 40; y++) {
    for (let x = 10; x < 20; x++) {
      const i = (y * 30 + x) * 4;
      now.data[i] = 0;
      now.data[i + 1] = 0;
      now.data[i + 2] = 0;
    }
  }
  nowBytes = PNG.sync.write(now);
  h.serverTmp = path.join(workDir, "server-tmp");
  await fs.mkdir(h.serverTmp);
  h.cleanups = [];
  restoreTmpdir = redirectTmpdir(h.serverTmp);
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  handle?.dispose();
  handle = undefined;
  restoreTmpdir();
  await fs.rm(workDir, { recursive: true, force: true });
});

/** One registry for the HTTP layer and the run: the real flow-execute and screenshot-diff. */
function realRegistry(): Registry {
  const registry = new Registry();
  registry.registerTool(createRunFlowTool(registry));
  registry.registerTool(screenshotDiffTool);
  return registry;
}

async function listen(app: HttpAppHandle["app"]): Promise<string> {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function* ndjsonLines(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim().length > 0) yield JSON.parse(line) as Record<string, unknown>;
      newline = buffered.indexOf("\n");
    }
  }
}

/**
 * One flow-execute call over the stream, as the argent client makes it for an
 * uploaded flow: the file arguments of its tool: step travel with the flow
 * file, inline, or `missing` when the client's disk has nothing there.
 * Resolves with every stream line and the terminal line.
 */
async function runOverLink(
  base: string,
  disk: Map<string, Buffer>
): Promise<{ lines: Record<string, unknown>[]; terminal: Record<string, unknown> }> {
  const members = [BASE, NOW].map((file) => {
    const content = disk.get(file);
    return content === undefined
      ? { role: "tool", key: file, path: file, state: "missing" }
      : {
          role: "tool",
          key: file,
          path: file,
          size: content.length,
          mtimeMs: 1,
          content: content.toString("base64"),
        };
  });
  const res = await fetch(`${base}/tools/flow-execute`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/x-ndjson" },
    body: JSON.stringify({
      project_root: "/client",
      device: DEVICE,
      flow_path: {
        __argentFileInput: true,
        path: ROOT_FLOW,
        size: Buffer.byteLength(FLOW_TEXT),
        mtimeMs: 1,
        content: Buffer.from(FLOW_TEXT).toString("base64"),
        canonical: ROOT_FLOW,
        spelling: { state: "listed" },
        members,
      },
    }),
  });
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");

  const lines: Record<string, unknown>[] = [];
  let terminal: Record<string, unknown> | undefined;
  for await (const line of ndjsonLines(res.body!)) {
    lines.push(line);
    if (line.event === "result" || line.event === "error") terminal = line;
  }
  return { lines, terminal: terminal! };
}

/** The server's tmpdir, relative paths of every file and directory in it. */
function serverTmpListing(): Promise<string[]> {
  return fs.readdir(h.serverTmp, { recursive: true });
}

describe("tool: steps whose file arguments the client sends over a link", () => {
  it("diffs the two PNGs the client sends, and keeps none of them on the server", async () => {
    const registry = realRegistry();
    const invoke = vi.spyOn(registry, "invokeTool");
    handle = createHttpApp(registry);
    const base = await listen(handle.app);
    const disk = new Map([
      [BASE, baseBytes],
      [NOW, nowBytes],
    ]);

    const { lines, terminal } = await runOverLink(base, disk);

    // Nothing is asked of the client during the run.
    expect(lines.map((line) => line.event).filter((event) => event !== "progress")).toEqual([
      "result",
    ]);
    expect(terminal.event).toBe("result");
    const data = terminal.data as {
      ok: boolean;
      steps: Array<{
        kind: string;
        status: string;
        tool?: string;
        args?: Record<string, unknown>;
        result?: { summary: string; diffPath?: Record<string, unknown> };
      }>;
    };
    expect(data.ok).toBe(true);
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    expect(step).toMatchObject({ kind: "tool", status: "pass", tool: "screenshot-diff" });
    // The report names the client's files, not the server's copies.
    expect(step.args).toEqual({ baselinePath: BASE, currentPath: NOW, udid: DEVICE });
    // 100 of the 1800 pixels differ: the diff read the two client PNGs.
    expect(step.result?.summary).toContain("5.56%");
    expect(step.result?.diffPath).toMatchObject({
      [ARTIFACT_MARKER]: true,
      kind: "screenshot-diff",
      mimeType: "image/png",
    });
    const diffPath = step.result!.diffPath!.hostPath as string;
    expect(PNG.sync.read(await fs.readFile(diffPath))).toMatchObject({ width: 30, height: 60 });

    // screenshot-diff ran on server temp copies, with the client paths as
    // what the call's file inputs came from.
    const call = invoke.mock.calls.find(([id]) => id === "screenshot-diff");
    expect(call).toBeDefined();
    const [, params, options] = call! as [
      string,
      Record<string, string>,
      Partial<ToolContext> | undefined,
    ];
    expect(params.baselinePath.startsWith(h.serverTmp)).toBe(true);
    expect(params.currentPath.startsWith(h.serverTmp)).toBe(true);
    expect(options?.fileInputs).toEqual({
      baselinePath: { clientPath: BASE, presentOnHost: false, viaUpload: true },
      currentPath: { clientPath: NOW, presentOnHost: false, viaUpload: true },
    });

    // Two cleanups: the step's, during the run, then the call's, once the
    // response closed. The step's removed both PNGs it had written; the call's
    // the flow and the PNGs it was sent.
    await vi.waitFor(() => expect(h.cleanups).toHaveLength(2));
    const [stepCleanup, callCleanup] = h.cleanups as [
      (typeof h.cleanups)[number],
      (typeof h.cleanups)[number],
    ];
    const written = [params.baselinePath, params.currentPath].map((p) =>
      path.relative(h.serverTmp, p)
    );
    expect(stepCleanup.before).toEqual(expect.arrayContaining(written));
    for (const file of written) {
      expect(stepCleanup.after).not.toContain(file);
      expect(stepCleanup.after).not.toContain(path.dirname(file));
    }
    expect(stepCleanup.after.some((f) => f.endsWith("withdiff.yaml"))).toBe(true);
    // After the call nothing it was sent is left: neither the flow nor a PNG.
    // What stays are the diff images, served as artifacts.
    expect(callCleanup.after.filter((f) => f.startsWith("argent-file-input-"))).toEqual([]);
    const left = await serverTmpListing();
    expect(left.filter((f) => f.startsWith("argent-file-input-"))).toEqual([]);
    expect(left.filter((f) => f.endsWith(".png"))).toEqual(
      expect.arrayContaining([path.relative(h.serverTmp, diffPath)])
    );
    expect(
      left.filter((f) => f.endsWith(".png") && !f.startsWith("argent-screenshot-diff"))
    ).toEqual([]);
  });

  it("fails the step when the client has no file at a path the step names", async () => {
    const registry = realRegistry();
    const invoke = vi.spyOn(registry, "invokeTool");
    handle = createHttpApp(registry);
    const base = await listen(handle.app);
    const disk = new Map([[BASE, baseBytes]]);

    const { terminal } = await runOverLink(base, disk);

    expect(terminal.event).toBe("result");
    const data = terminal.data as {
      ok: boolean;
      steps: Array<{ kind: string; status: string; reason?: string }>;
    };
    expect(data.ok).toBe(false);
    expect(data.steps).toEqual([
      expect.objectContaining({
        kind: "tool",
        status: "error",
        reason: `the client has no file at "${NOW}" (argument currentPath of screenshot-diff)`,
      }),
    ]);
    // The tool never ran, and nothing of the step stayed on the server.
    expect(invoke.mock.calls.map(([id]) => id)).toEqual(["flow-execute"]);
    await vi.waitFor(() => expect(h.cleanups).toHaveLength(1));
    expect((await serverTmpListing()).filter((f) => f.endsWith(".png"))).toEqual([]);
  });
});
