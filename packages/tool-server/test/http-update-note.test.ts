import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";

let suppressed = false;

// Mock update-checker before any imports that use it transitively.
vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => suppressed),
  suppressUpdateNote: vi.fn(),
}));

import { getUpdateState, suppressUpdateNote } from "../src/utils/update-checker";

const mockGetUpdateState = vi.mocked(getUpdateState);
const mockSuppressUpdateNote = vi.mocked(suppressUpdateNote);

function stubRegistry(toolResult: unknown = { ok: true }): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["test-tool"] })),
    getTool: vi.fn((name: string) => {
      if (name === "test-tool") {
        return {
          id: "test-tool",
          description: "A stub tool for testing",
          inputSchema: { type: "object", properties: {} },
          services: () => ({}),
          execute: async () => toolResult,
        };
      }
      return undefined;
    }),
    invokeTool: vi.fn(async (_name: string, _params: unknown) => toolResult),
  } as unknown as Registry;
}

describe("HTTP update note injection", () => {
  let handle: HttpAppHandle;
  const request = supertest;

  beforeEach(async () => {
    suppressed = false;
    mockGetUpdateState.mockReturnValue({
      updateAvailable: false,
      latestVersion: null,
      currentVersion: "1.0.0",
    });
    mockSuppressUpdateNote.mockClear();
  });

  afterEach(() => {
    handle?.dispose();
    vi.clearAllMocks();
  });

  it("does NOT include a note when update is not available", async () => {
    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body).toHaveProperty("data");
    expect(res.body).not.toHaveProperty("note");
  });

  it("includes a note when update is available", async () => {
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: "1.2.3",
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("note");
    expect(typeof res.body.note).toBe("string");
    expect(res.body.note.length).toBeGreaterThan(0);
  });

  it("note contains the current -> latest version string", async () => {
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: "1.2.3",
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("1.0.0 -> 1.2.3");
  });

  it("note mentions `npx @swmansion/argent update`", async () => {
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: "1.2.3",
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("npx @swmansion/argent update");
  });

  it("note mentions `update-argent` tool", async () => {
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: "1.2.3",
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("update-argent");
  });

  it("note mentions `dismiss-update` tool", async () => {
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: "1.2.3",
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("dismiss-update");
  });

  it("note instructs agent to persist the update info", async () => {
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: "1.2.3",
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("Save a note");
  });

  it("does NOT include a note on 500 error responses", async () => {
    const errorRegistry = {
      getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["test-tool"] })),
      getTool: vi.fn(() => ({
        id: "test-tool",
        description: "A stub tool",
        inputSchema: {},
        services: () => ({}),
        execute: async () => {
          throw new Error("tool blew up");
        },
      })),
      invokeTool: vi.fn(async () => {
        throw new Error("tool blew up");
      }),
    } as unknown as Registry;

    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: "1.2.3",
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(errorRegistry);

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(500);

    expect(res.body).toHaveProperty("error");
    expect(res.body).not.toHaveProperty("note");
  });

  it("does NOT include a note on 404 (unknown tool) responses", async () => {
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: "1.2.3",
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/nonexistent-tool").send({}).expect(404);

    expect(res.body).toHaveProperty("error");
    expect(res.body).not.toHaveProperty("note");
  });

  it("note says 'unknown' when latestVersion is null but updateAvailable is true", async () => {
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: null,
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body).toHaveProperty("note");
    expect(res.body.note).toContain("unknown");
    expect(res.body.note).not.toContain("null");
  });

  // ── Suppression behavior ──────────────────────────────────────────

  it("calls suppressUpdateNote after delivering a note", async () => {
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: "1.2.3",
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(stubRegistry());

    await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(mockSuppressUpdateNote).toHaveBeenCalledOnce();
    expect(mockSuppressUpdateNote).toHaveBeenCalledWith(30 * 60 * 1000);
  });

  it("does NOT include a note when suppressed", async () => {
    suppressed = true;
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      latestVersion: "1.2.3",
      currentVersion: "1.0.0",
    });

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body).toHaveProperty("data");
    expect(res.body).not.toHaveProperty("note");
    expect(mockSuppressUpdateNote).not.toHaveBeenCalled();
  });

  it("does NOT call suppressUpdateNote when no update is available", async () => {
    handle = createHttpApp(stubRegistry());

    await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(mockSuppressUpdateNote).not.toHaveBeenCalled();
  });
});
