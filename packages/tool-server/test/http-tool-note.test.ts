import { describe, it, expect, vi, afterEach } from "vitest";
import supertest from "supertest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";
import { RESULT_NOTE_KEY } from "../src/tools/screenshot/dropped-geometry";

// Keep the update note out of these assertions (same approach as the other
// http-*.test.ts files): no update available, never suppressed.
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

function stubRegistry(toolResult: () => unknown): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["test-tool"] })),
    getTool: vi.fn((name: string) =>
      name === "test-tool"
        ? {
            id: "test-tool",
            description: "A stub tool for testing",
            inputSchema: { type: "object", properties: {} },
            services: () => ({}),
            execute: async () => toolResult(),
          }
        : undefined
    ),
    invokeTool: vi.fn(async () => toolResult()),
  } as unknown as Registry;
}

describe("HTTP per-call tool note", () => {
  let handle: HttpAppHandle;

  afterEach(() => {
    handle?.dispose();
    vi.clearAllMocks();
  });

  it("hoists the reserved key into the envelope note and strips it from data", async () => {
    handle = createHttpApp(
      stubRegistry(() => ({ image: "x", [RESULT_NOTE_KEY]: "scale was not applied" }))
    );
    const res = await supertest(handle.app).post("/tools/test-tool").send({});
    expect(res.status).toBe(200);
    expect(res.body.note).toBe("scale was not applied");
    expect(res.body.data).toEqual({ image: "x" });
  });

  it("does the same on the NDJSON stream path", async () => {
    handle = createHttpApp(stubRegistry(() => ({ image: "x", [RESULT_NOTE_KEY]: "dropped" })));
    const res = await supertest(handle.app)
      .post("/tools/test-tool")
      .set("Accept", "application/x-ndjson")
      .send({});
    expect(res.status).toBe(200);
    const lines = res.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; data?: unknown; note?: string });
    const result = lines.find((l) => l.event === "result");
    expect(result?.note).toBe("dropped");
    expect(result?.data).toEqual({ image: "x" });
  });

  it("strips an empty or non-string value without raising a note", async () => {
    handle = createHttpApp(stubRegistry(() => ({ image: "x", [RESULT_NOTE_KEY]: "" })));
    const res = await supertest(handle.app).post("/tools/test-tool").send({});
    expect(res.body.note).toBeUndefined();
    expect(res.body.data).toEqual({ image: "x" });
  });

  it("leaves results without the key untouched", async () => {
    handle = createHttpApp(stubRegistry(() => ({ image: "x" })));
    const res = await supertest(handle.app).post("/tools/test-tool").send({});
    expect(res.body.note).toBeUndefined();
    expect(res.body.data).toEqual({ image: "x" });
  });
});
