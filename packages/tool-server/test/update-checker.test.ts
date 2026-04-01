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
    const { version: currentVersion } = await import("../../package.json");

    const mockGet = vi.mocked(https.get);
    mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
      callback(
        createMockResponse(200, JSON.stringify({ version: currentVersion })),
      );
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

    // Advance 1 hour — should trigger another check.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
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
});
