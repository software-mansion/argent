import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { UpdateState } from "../src/utils/update-checker";
import type { Registry } from "@argent/registry";

let suppressed = false;
let updateNotificationOff = false;

/** Build a full UpdateState from partial overrides so tests stay terse. */
function mkState(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    updateAvailable: false,
    updateInstallable: false,
    installableVersion: null,
    latestVersion: null,
    latestPublishedAt: null,
    minReleaseAgeMs: 0,
    currentVersion: "1.0.0",
    ...overrides,
  };
}

// Mock update-checker before any imports that use it transitively.
vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn((): UpdateState => mkState()),
  isUpdateNoteSuppressed: vi.fn(() => suppressed),
  suppressUpdateNote: vi.fn(),
}));

// Mock the permanent opt-out flag so tests need not touch the real flags file.
vi.mock("../src/utils/update-reminder", () => ({
  updateNotificationDisabled: vi.fn(() => updateNotificationOff),
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
    updateNotificationOff = false;
    mockGetUpdateState.mockReturnValue(mkState());
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

  it("includes a note when an installable update is available", async () => {
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("note");
    expect(typeof res.body.note).toBe("string");
    expect(res.body.note.length).toBeGreaterThan(0);
  });

  it("does NOT include a note when an update is available but held by the release-age policy", async () => {
    // Newer version exists, but it has not aged past the machine's policy yet,
    // so it is not installable — the reminder must stay silent.
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: false,
        latestVersion: "1.2.3",
        minReleaseAgeMs: 7 * 24 * 60 * 60 * 1000,
      })
    );

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body).toHaveProperty("data");
    expect(res.body).not.toHaveProperty("note");
    expect(mockSuppressUpdateNote).not.toHaveBeenCalled();
  });

  it("note contains the current -> latest version string", async () => {
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("1.0.0 -> 1.2.3");
  });

  it("note mentions `npx @swmansion/argent update`", async () => {
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("npx @swmansion/argent update");
  });

  it("note mentions `update-argent` tool", async () => {
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("update-argent");
  });

  it("note mentions `dismiss-update` tool", async () => {
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("dismiss-update");
  });

  it("note instructs agent to persist the update info", async () => {
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

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

    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

    handle = createHttpApp(errorRegistry);

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(500);

    expect(res.body).toHaveProperty("error");
    expect(res.body).not.toHaveProperty("note");
  });

  it("does NOT include a note on 404 (unknown tool) responses", async () => {
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/nonexistent-tool").send({}).expect(404);

    expect(res.body).toHaveProperty("error");
    expect(res.body).not.toHaveProperty("note");
  });

  it("note says 'unknown' when installableVersion is null but the update is installable", async () => {
    mockGetUpdateState.mockReturnValue(
      mkState({ updateAvailable: true, updateInstallable: true, installableVersion: null })
    );

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body).toHaveProperty("note");
    expect(res.body.note).toContain("unknown");
    expect(res.body.note).not.toContain("null");
  });

  // ── Suppression behavior ──────────────────────────────────────────

  it("calls suppressUpdateNote after delivering a note", async () => {
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

    handle = createHttpApp(stubRegistry());

    await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(mockSuppressUpdateNote).toHaveBeenCalledOnce();
    expect(mockSuppressUpdateNote).toHaveBeenCalledWith(30 * 60 * 1000);
  });

  it("does NOT include a note when suppressed", async () => {
    suppressed = true;
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

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

  // ── Permanent opt-out flag (disable-update-notification) ──────────

  it("does NOT include a note when the disable-update-notification flag is on", async () => {
    updateNotificationOff = true;
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body).toHaveProperty("data");
    expect(res.body).not.toHaveProperty("note");
  });

  it("does NOT call suppressUpdateNote when the flag is on (must not burn the temporary window)", async () => {
    updateNotificationOff = true;
    mockGetUpdateState.mockReturnValue(
      mkState({
        updateAvailable: true,
        updateInstallable: true,
        latestVersion: "1.2.3",
        installableVersion: "1.2.3",
      })
    );

    handle = createHttpApp(stubRegistry());

    await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(mockSuppressUpdateNote).not.toHaveBeenCalled();
  });
});
