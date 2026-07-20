import { describe, it, expect, vi, afterEach } from "vitest";
import supertest from "supertest";
import type { Response } from "superagent";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry, InvokeToolOptions } from "@argent/registry";

// Streaming rides the same response path as the update note — pin the checker
// to "no update" so result lines stay minimal and deterministic.
vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    updateInstallable: false,
    installableVersion: null,
    latestVersion: null,
    latestPublishedAt: null,
    minReleaseAgeMs: 0,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => false),
  suppressUpdateNote: vi.fn(),
}));

function stubRegistry(
  impl: (options: InvokeToolOptions | undefined) => Promise<unknown>
): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["test-tool"] })),
    getTool: vi.fn((name: string) =>
      name === "test-tool"
        ? {
            id: "test-tool",
            description: "A stub tool for testing",
            inputSchema: { type: "object", properties: {} },
            services: () => ({}),
            execute: async () => ({ ok: true }),
          }
        : undefined
    ),
    invokeTool: vi.fn((_name: string, _params: unknown, options?: InvokeToolOptions) =>
      impl(options)
    ),
  } as unknown as Registry;
}

/** Collect a non-JSON response body as raw text (supertest only parses JSON). */
function collectText(res: Response, cb: (err: Error | null, body: string) => void): void {
  let text = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => (text += chunk));
  res.on("end", () => cb(null, text));
}

function parseLines(body: string): Array<Record<string, unknown>> {
  return body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("HTTP NDJSON streaming (Accept: application/x-ndjson)", () => {
  let handle: HttpAppHandle;

  afterEach(() => {
    handle?.dispose();
    vi.clearAllMocks();
  });

  it("streams each emitProgress event as a line, then the terminal result", async () => {
    const registry = stubRegistry(async (options) => {
      options?.emitProgress?.({ index: 0, status: "pass" });
      options?.emitProgress?.({ index: 1, status: "fail" });
      return { ok: false, steps: 2 };
    });
    handle = createHttpApp(registry);

    const res = await supertest(handle.app)
      .post("/tools/test-tool")
      .set("Accept", "application/x-ndjson")
      .send({})
      .buffer(true)
      .parse(collectText)
      .expect(200);

    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const lines = parseLines(res.body as string);
    expect(lines).toEqual([
      { event: "progress", data: { index: 0, status: "pass" } },
      { event: "progress", data: { index: 1, status: "fail" } },
      { event: "result", data: { ok: false, steps: 2 } },
    ]);
  });

  it("does NOT pass emitProgress (nor stream) without the Accept header", async () => {
    let seenOptions: InvokeToolOptions | undefined;
    const registry = stubRegistry(async (options) => {
      seenOptions = options;
      return { ok: true };
    });
    handle = createHttpApp(registry);

    const res = await supertest(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(seenOptions?.emitProgress).toBeUndefined();
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({ data: { ok: true } });
  });

  it("delivers a tool failure as an in-band terminal error line", async () => {
    const registry = stubRegistry(async (options) => {
      options?.emitProgress?.({ index: 0, status: "pass" });
      throw new Error("device went away");
    });
    handle = createHttpApp(registry);

    // Headers are already on the wire when the tool fails, so the status stays
    // 200 and the error rides the stream's terminal line.
    const res = await supertest(handle.app)
      .post("/tools/test-tool")
      .set("Accept", "application/x-ndjson")
      .send({})
      .buffer(true)
      .parse(collectText)
      .expect(200);

    const lines = parseLines(res.body as string);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ event: "progress", data: { index: 0, status: "pass" } });
    expect(lines[1].event).toBe("error");
    expect(String(lines[1].error)).toContain("device went away");
  });

  it("keeps plain-JSON status codes for failures before the invoke (unknown tool)", async () => {
    handle = createHttpApp(stubRegistry(async () => ({ ok: true })));

    // The 404 gate fires before the response commits to streaming.
    const res = await supertest(handle.app)
      .post("/tools/nope")
      .set("Accept", "application/x-ndjson")
      .send({})
      .expect(404);

    expect(res.body.error).toContain("nope");
  });
});
