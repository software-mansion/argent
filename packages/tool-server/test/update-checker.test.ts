import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "node:https";
import { EventEmitter } from "node:events";

// We need to mock https before importing the module under test.
vi.mock("node:https");

// Stable mock for the minimum-release-age probe so tests never shell out to a
// real package manager. Created via vi.hoisted so the same fn instance survives
// the vi.resetModules() in beforeEach and is the one update-checker binds to.
const { mockDetectMinReleaseAgeMs } = vi.hoisted(() => ({
  mockDetectMinReleaseAgeMs: vi.fn<() => Promise<number>>(),
}));
vi.mock("../src/utils/min-release-age", () => ({
  detectMinReleaseAgeMs: mockDetectMinReleaseAgeMs,
}));

let getUpdateState: typeof import("../src/utils/update-checker").getUpdateState;
let startUpdateChecker: typeof import("../src/utils/update-checker").startUpdateChecker;

const NOW = new Date("2026-06-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Build an npm packument body with a `dist-tags.latest` and optional publish time. */
function packument(version: string, publishedAt?: string): string {
  const time: Record<string, string> = {};
  if (publishedAt) time[version] = publishedAt;
  return JSON.stringify({ "dist-tags": { latest: version }, time });
}

/** Build a packument with an explicit `latest` tag and a version → publish-time map. */
function packumentMulti(latest: string, times: Record<string, string>): string {
  return JSON.stringify({ "dist-tags": { latest }, "time": times });
}

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

/** Wire https.get to invoke its callback with a mock response carrying `body`. */
function mockResponseBody(statusCode: number, body: string) {
  const mockGet = vi.mocked(https.get);
  mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
    const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
    callback(createMockResponse(statusCode, body));
    return new EventEmitter() as ReturnType<typeof https.get>;
  });
  return mockGet;
}

describe("update-checker", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetModules();
    // Reset the auto-mocked https.get call history between tests — several
    // assertions check exact call counts and the auto-mock is not a restorable spy.
    vi.clearAllMocks();
    delete process.env.ARGENT_DISABLE_UPDATE_NOTIFICATIONS;
    mockDetectMinReleaseAgeMs.mockReset();
    mockDetectMinReleaseAgeMs.mockResolvedValue(0); // no policy by default

    // Re-import after module reset so each test gets fresh state.
    const mod = await import("../src/utils/update-checker");
    getUpdateState = mod.getUpdateState;
    startUpdateChecker = mod.startUpdateChecker;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.ARGENT_DISABLE_UPDATE_NOTIFICATIONS;
  });

  it("detects an available, installable update on startup", async () => {
    mockResponseBody(200, packument("99.0.0", "2020-01-01T00:00:00Z"));

    const handle = startUpdateChecker();

    // Let the fire-and-forget promise resolve.
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(true);
    expect(state.updateInstallable).toBe(true);
    expect(state.installableVersion).toBe("99.0.0");
    expect(state.latestVersion).toBe("99.0.0");
    expect(state.latestPublishedAt).toBe("2020-01-01T00:00:00Z");

    handle.dispose();
  });

  it("reports no update when versions match", async () => {
    const { version: currentVersion } = await import("../package.json");

    mockResponseBody(200, packument(currentVersion, "2020-01-01T00:00:00Z"));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.updateInstallable).toBe(false);
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
    const mockGet = mockResponseBody(200, packument("99.0.0", "2020-01-01T00:00:00Z"));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Advance 24 hours — should trigger another check.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 * 24);
    expect(mockGet).toHaveBeenCalledTimes(2);

    handle.dispose();
  });

  it("stops checking after dispose", async () => {
    const mockGet = mockResponseBody(200, packument("99.0.0", "2020-01-01T00:00:00Z"));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGet).toHaveBeenCalledTimes(1);

    handle.dispose();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockGet).toHaveBeenCalledTimes(1); // No additional calls after dispose.
  });

  it("handles non-200 responses gracefully", async () => {
    mockResponseBody(404, "Not Found");

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.latestVersion).toBeNull();

    handle.dispose();
  });

  // ── Semver comparison ─────────────────────────────────────────────

  it("does not flag update when running a newer local version", async () => {
    // npm returns 0.1.0 but local is ahead.
    mockResponseBody(200, packument("0.1.0", "2020-01-01T00:00:00Z"));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.latestVersion).toBe("0.1.0");

    handle.dispose();
  });

  it("does not flag update for pre-release version strings", async () => {
    // npm returns a pre-release tag — should never be pushed.
    mockResponseBody(200, packument("1.0.0-beta.1", "2020-01-01T00:00:00Z"));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);

    handle.dispose();
  });

  // ── Minimum-release-age policy ─────────────────────────────────────

  it("flags available but NOT installable when the latest version is younger than the policy", async () => {
    mockDetectMinReleaseAgeMs.mockResolvedValue(7 * DAY_MS); // 7-day policy
    // Published 1 day ago — inside the 7-day window.
    const oneDayAgo = new Date(NOW.getTime() - 1 * DAY_MS).toISOString();
    mockResponseBody(200, packument("99.0.0", oneDayAgo));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(true);
    expect(state.updateInstallable).toBe(false);
    expect(state.installableVersion).toBeNull();
    expect(state.minReleaseAgeMs).toBe(7 * DAY_MS);

    handle.dispose();
  });

  it("flags installable once the latest version has aged past the policy", async () => {
    mockDetectMinReleaseAgeMs.mockResolvedValue(7 * DAY_MS); // 7-day policy
    // Published 10 days ago — past the 7-day window.
    const tenDaysAgo = new Date(NOW.getTime() - 10 * DAY_MS).toISOString();
    mockResponseBody(200, packument("99.0.0", tenDaysAgo));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(true);
    expect(state.updateInstallable).toBe(true);
    expect(state.installableVersion).toBe("99.0.0");

    handle.dispose();
  });

  it("recommends the newest version that clears the policy when the latest publish is held", async () => {
    mockDetectMinReleaseAgeMs.mockResolvedValue(7 * DAY_MS); // 7-day policy
    const oneDayAgo = new Date(NOW.getTime() - 1 * DAY_MS).toISOString();
    const tenDaysAgo = new Date(NOW.getTime() - 10 * DAY_MS).toISOString();
    // latest tag 99.0.0 is too new (held); 98.0.0 has aged past the gate. The
    // resolver would install 98.0.0, so that is what we should advertise.
    mockResponseBody(200, packumentMulti("99.0.0", { "98.0.0": tenDaysAgo, "99.0.0": oneDayAgo }));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(true); // 99.0.0 > current exists
    expect(state.latestVersion).toBe("99.0.0");
    expect(state.updateInstallable).toBe(true);
    expect(state.installableVersion).toBe("98.0.0"); // newest eligible, not the latest tag

    handle.dispose();
  });

  it("is NOT installable under a policy when the publish time is unknown", async () => {
    mockDetectMinReleaseAgeMs.mockResolvedValue(7 * DAY_MS);
    mockResponseBody(200, packument("99.0.0")); // no time entry

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(true);
    expect(state.updateInstallable).toBe(false);
    expect(state.installableVersion).toBeNull();
    expect(state.latestPublishedAt).toBeNull();

    handle.dispose();
  });

  // ── Disable flag ───────────────────────────────────────────────────

  it("does not check or notify when notifications are disabled", async () => {
    process.env.ARGENT_DISABLE_UPDATE_NOTIFICATIONS = "1";
    vi.resetModules();
    const mod = await import("../src/utils/update-checker");

    const mockGet = mockResponseBody(200, packument("99.0.0", "2020-01-01T00:00:00Z"));

    const handle = mod.startUpdateChecker();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 * 24);

    expect(mockGet).not.toHaveBeenCalled();
    expect(mod.getUpdateState().updateInstallable).toBe(false);
    expect(mod.areUpdateNotificationsDisabled()).toBe(true);

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
    const mockGet = mockResponseBody(200, packument("99.0.0", "2020-01-01T00:00:00Z"));

    const handle1 = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Start a second checker — should clear the first interval.
    const handle2 = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGet).toHaveBeenCalledTimes(2);

    // Advance 24 hours — should trigger exactly 1 check (from handle2), not 2.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 * 24);
    expect(mockGet).toHaveBeenCalledTimes(3);

    handle1.dispose();
    handle2.dispose();
  });
});
