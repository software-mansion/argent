import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";
import {
  __resetActiveScreenRecordingsForTesting,
  buildScreenRecordingNote,
  clearActiveScreenRecording,
  getActiveScreenRecordings,
  markScreenRecordingFinalized,
  registerActiveScreenRecording,
} from "../src/utils/screen-recording-reminder";

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

import { getUpdateState } from "../src/utils/update-checker";

const mockGetUpdateState = vi.mocked(getUpdateState);

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
    invokeTool: vi.fn(async () => toolResult),
  } as unknown as Registry;
}

const UDID = "6DBF83B4-0000-0000-0000-000000000000";

describe("HTTP screen-recording reminder note", () => {
  let handle: HttpAppHandle;
  const request = supertest;

  beforeEach(() => {
    __resetActiveScreenRecordingsForTesting();
  });

  afterEach(() => {
    handle?.dispose();
    __resetActiveScreenRecordingsForTesting();
    vi.clearAllMocks();
  });

  it("does NOT include a note when no recording is active", async () => {
    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body).toHaveProperty("data");
    expect(res.body).not.toHaveProperty("note");
  });

  it("attaches the reminder to every successful tool call while recording", async () => {
    registerActiveScreenRecording(UDID, Date.now(), 180);
    handle = createHttpApp(stubRegistry());

    for (let call = 0; call < 3; call++) {
      const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);
      expect(res.body.note).toContain("screen recording is still running");
      expect(res.body.note).toContain(UDID);
      expect(res.body.note).toContain("screen-recording-stop");
    }
  });

  it("tells the agent the exact stop call, including the udid parameter", async () => {
    registerActiveScreenRecording(UDID, Date.now(), 60);
    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain(`{ "udid": "${UDID}" }`);
    expect(res.body.note).toContain("auto-stops after 60s");
  });

  it("switches to the retrieval reminder once the capture finalized on its own", async () => {
    registerActiveScreenRecording(UDID, Date.now(), 180);
    markScreenRecordingFinalized(UDID, "it hit its 180s time limit");
    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("already ended");
    expect(res.body.note).toContain("it hit its 180s time limit");
    expect(res.body.note).toContain("screen-recording-stop");
  });

  it("drops the note once the recording is cleared", async () => {
    registerActiveScreenRecording(UDID, Date.now(), 180);
    handle = createHttpApp(stubRegistry());

    await request(handle.app).post("/tools/test-tool").send({}).expect(200);
    clearActiveScreenRecording(UDID);

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);
    expect(res.body).not.toHaveProperty("note");
  });

  it("lists every device when several recordings run concurrently", async () => {
    registerActiveScreenRecording(UDID, Date.now(), 180);
    registerActiveScreenRecording("emulator-5554", Date.now(), 120);
    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain(UDID);
    expect(res.body.note).toContain("emulator-5554");
  });

  it("joins the update note and the recording reminder when both apply", async () => {
    mockGetUpdateState.mockReturnValue({
      updateAvailable: true,
      updateInstallable: true,
      installableVersion: "1.2.3",
      latestVersion: "1.2.3",
      latestPublishedAt: null,
      minReleaseAgeMs: 0,
      currentVersion: "1.0.0",
    });
    registerActiveScreenRecording(UDID, Date.now(), 180);
    handle = createHttpApp(stubRegistry());

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(res.body.note).toContain("1.0.0 -> 1.2.3");
    expect(res.body.note).toContain("screen-recording-stop");
  });

  it("does NOT include a note on tool error responses", async () => {
    registerActiveScreenRecording(UDID, Date.now(), 180);
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
    handle = createHttpApp(errorRegistry);

    const res = await request(handle.app).post("/tools/test-tool").send({}).expect(500);

    expect(res.body).toHaveProperty("error");
    expect(res.body).not.toHaveProperty("note");
  });
});

describe("screen-recording reminder state & note builder", () => {
  beforeEach(() => {
    __resetActiveScreenRecordingsForTesting();
  });

  it("register/clear round-trips and re-register resets a finalized entry", () => {
    registerActiveScreenRecording(UDID, 1_000, 180);
    markScreenRecordingFinalized(UDID, "it died");
    expect(getActiveScreenRecordings()[0]?.status).toBe("finalized");

    registerActiveScreenRecording(UDID, 2_000, 60);
    const entry = getActiveScreenRecordings()[0]!;
    expect(entry.status).toBe("recording");
    expect(entry.startedAtMs).toBe(2_000);

    clearActiveScreenRecording(UDID);
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });

  it("marking an unknown device as finalized is a no-op", () => {
    markScreenRecordingFinalized("nope", "whatever");
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });

  it("formats elapsed time in minutes and seconds", () => {
    const startedAt = 0;
    registerActiveScreenRecording(UDID, startedAt, 300);
    const note = buildScreenRecordingNote(getActiveScreenRecordings(), 125_000);
    expect(note).toContain("started 2m 5s ago");
    expect(note).toContain("auto-stops after 300s");
  });

  it("clamps a clock skew to zero elapsed instead of going negative", () => {
    registerActiveScreenRecording(UDID, 10_000, 300);
    const note = buildScreenRecordingNote(getActiveScreenRecordings(), 5_000);
    expect(note).toContain("started 0s ago");
  });
});
