import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

describe("update-checker — suppression persistence", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "argent-suppress-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const suppressionFile = () => path.join(tmpHome, ".argent", "update-suppression.json");

  it("loads no suppression when the file is missing", async () => {
    const { isUpdateNoteSuppressed } = await import("../src/utils/update-checker");
    expect(isUpdateNoteSuppressed()).toBe(false);
  });

  it("loads no suppression when the file is malformed", async () => {
    fs.mkdirSync(path.dirname(suppressionFile()), { recursive: true });
    fs.writeFileSync(suppressionFile(), "not json");
    const { isUpdateNoteSuppressed } = await import("../src/utils/update-checker");
    expect(isUpdateNoteSuppressed()).toBe(false);
  });

  it("loads no suppression when suppressUntil is not a number", async () => {
    fs.mkdirSync(path.dirname(suppressionFile()), { recursive: true });
    fs.writeFileSync(suppressionFile(), JSON.stringify({ suppressUntil: "soon" }));
    const { isUpdateNoteSuppressed } = await import("../src/utils/update-checker");
    expect(isUpdateNoteSuppressed()).toBe(false);
  });

  it("honors a future suppressUntil read from disk", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    fs.mkdirSync(path.dirname(suppressionFile()), { recursive: true });
    fs.writeFileSync(
      suppressionFile(),
      JSON.stringify({ suppressUntil: Date.now() + 60 * 60 * 1000 })
    );
    const { isUpdateNoteSuppressed } = await import("../src/utils/update-checker");
    expect(isUpdateNoteSuppressed()).toBe(true);
  });

  it("treats a past suppressUntil as not suppressed", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    fs.mkdirSync(path.dirname(suppressionFile()), { recursive: true });
    fs.writeFileSync(suppressionFile(), JSON.stringify({ suppressUntil: Date.now() - 1000 }));
    const { isUpdateNoteSuppressed } = await import("../src/utils/update-checker");
    expect(isUpdateNoteSuppressed()).toBe(false);
  });

  it("writes the suppression timestamp to disk on suppressUpdateNote", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { suppressUpdateNote } = await import("../src/utils/update-checker");
    suppressUpdateNote(60 * 60 * 1000);
    const raw = fs.readFileSync(suppressionFile(), "utf8");
    expect(JSON.parse(raw)).toEqual({ suppressUntil: Date.now() + 60 * 60 * 1000 });
  });

  it("creates the .argent directory if it does not exist", async () => {
    expect(fs.existsSync(path.join(tmpHome, ".argent"))).toBe(false);
    const { suppressUpdateNote } = await import("../src/utils/update-checker");
    suppressUpdateNote(1000);
    expect(fs.existsSync(suppressionFile())).toBe(true);
  });

  it("survives a module reload (simulates tool-server process restart)", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = await import("../src/utils/update-checker");
    first.suppressUpdateNote(60 * 60 * 1000);
    expect(first.isUpdateNoteSuppressed()).toBe(true);

    // Simulate restart: clear the module cache and re-import. The new module
    // must read the suppression back from disk.
    vi.resetModules();
    const second = await import("../src/utils/update-checker");
    expect(second.isUpdateNoteSuppressed()).toBe(true);
  });

  it("throws when the suppression file cannot be written", async () => {
    // Replace the .argent path with a regular file so mkdir/write fails.
    fs.writeFileSync(path.join(tmpHome, ".argent"), "");
    const { suppressUpdateNote } = await import("../src/utils/update-checker");
    expect(() => suppressUpdateNote(1000)).toThrow();
  });
});
