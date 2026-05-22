import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "node:https";
import { EventEmitter } from "node:events";

// We need to mock https before importing the module under test.
vi.mock("node:https");

let getUpdateState: typeof import("../src/utils/update-checker").getUpdateState;
let startUpdateChecker: typeof import("../src/utils/update-checker").startUpdateChecker;

function createMockResponse(statusCode: number, body: string) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    setEncoding: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };
  res.statusCode = statusCode;
  res.setEncoding = vi.fn();
  res.resume = vi.fn();

  // Emit data + end on next tick so the handler can attach listeners first.
  process.nextTick(() => {
    res.emit("data", body);
    res.emit("end");
  });

  return res;
}

describe("update-checker", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    // Re-import after module reset so each test gets fresh state.
    const mod = await import("../src/utils/update-checker");
    getUpdateState = mod.getUpdateState;
    startUpdateChecker = mod.startUpdateChecker;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("detects an available update on startup", async () => {
    const mockGet = vi.mocked(https.get);
    mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
      callback(createMockResponse(200, JSON.stringify({ version: "99.0.0" })));
      return new EventEmitter() as ReturnType<typeof https.get>;
    });

    const handle = startUpdateChecker();

    // Let the fire-and-forget promise resolve.
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(true);
    expect(state.latestVersion).toBe("99.0.0");

    handle.dispose();
  });

  it("reports no update when versions match", async () => {
    const { version: currentVersion } = await import("../package.json");

    const mockGet = vi.mocked(https.get);
    mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
      callback(createMockResponse(200, JSON.stringify({ version: currentVersion })));
      return new EventEmitter() as ReturnType<typeof https.get>;
    });

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.latestVersion).toBe(currentVersion);

    handle.dispose();
  });

  it("keeps previous state on network failure", async () => {
    const mockGet = vi.mocked(https.get);
    mockGet.mockImplementation((_url: unknown, _opts: unknown, _cb: unknown) => {
      const req = new EventEmitter() as ReturnType<typeof https.get>;
      process.nextTick(() => req.emit("error", new Error("ENOTFOUND")));
      return req;
    });

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.latestVersion).toBeNull();

    handle.dispose();
  });

  it("rechecks after the interval", async () => {
    const mockGet = vi.mocked(https.get);
    let callCount = 0;
    mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      callCount++;
      const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
      callback(createMockResponse(200, JSON.stringify({ version: "99.0.0" })));
      return new EventEmitter() as ReturnType<typeof https.get>;
    });

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // Advance 24 hours — should trigger another check.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 * 24);
    expect(callCount).toBe(2);

    handle.dispose();
  });

  it("stops checking after dispose", async () => {
    const mockGet = vi.mocked(https.get);
    let callCount = 0;
    mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      callCount++;
      const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
      callback(createMockResponse(200, JSON.stringify({ version: "99.0.0" })));
      return new EventEmitter() as ReturnType<typeof https.get>;
    });

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    handle.dispose();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(callCount).toBe(1); // No additional calls after dispose.
  });

  it("handles non-200 responses gracefully", async () => {
    const mockGet = vi.mocked(https.get);
    mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
      const res = createMockResponse(404, "Not Found");
      callback(res);
      return new EventEmitter() as ReturnType<typeof https.get>;
    });

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.latestVersion).toBeNull();

    handle.dispose();
  });

  // ── Semver comparison ─────────────────────────────────────────────

  it("does not flag update when running a newer local version", async () => {
    const mockGet = vi.mocked(https.get);
    // npm returns 0.1.0 but local is 0.3.3 — local is ahead
    mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
      callback(createMockResponse(200, JSON.stringify({ version: "0.1.0" })));
      return new EventEmitter() as ReturnType<typeof https.get>;
    });

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.latestVersion).toBe("0.1.0");

    handle.dispose();
  });

  it("does not flag update for pre-release version strings", async () => {
    const mockGet = vi.mocked(https.get);
    // npm returns a pre-release tag — non-semver, should be treated safely
    mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
      callback(createMockResponse(200, JSON.stringify({ version: "1.0.0-beta.1" })));
      return new EventEmitter() as ReturnType<typeof https.get>;
    });

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);

    handle.dispose();
  });

  // ── Response stream error ─────────────────────────────────────────

  it("handles response error event without crashing", async () => {
    const mockGet = vi.mocked(https.get);
    mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        setEncoding: ReturnType<typeof vi.fn>;
        resume: ReturnType<typeof vi.fn>;
      };
      res.statusCode = 200;
      res.setEncoding = vi.fn();
      res.resume = vi.fn();

      // Simulate a connection reset mid-stream
      process.nextTick(() => {
        res.emit("data", '{"ver');
        res.emit("error", new Error("ECONNRESET"));
      });

      callback(res);
      return new EventEmitter() as ReturnType<typeof https.get>;
    });

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.latestVersion).toBeNull();

    handle.dispose();
  });

  // ── Double start guard ────────────────────────────────────────────

  it("clears previous interval when startUpdateChecker is called twice", async () => {
    const mockGet = vi.mocked(https.get);
    let callCount = 0;
    mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      callCount++;
      const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
      callback(createMockResponse(200, JSON.stringify({ version: "99.0.0" })));
      return new EventEmitter() as ReturnType<typeof https.get>;
    });

    const handle1 = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // Start a second checker — should clear the first interval.
    const handle2 = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(2);

    // Advance 24 hours — should trigger exactly 1 check (from handle2), not 2.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 * 24);
    expect(callCount).toBe(3);

    handle1.dispose();
    handle2.dispose();
  });
});
