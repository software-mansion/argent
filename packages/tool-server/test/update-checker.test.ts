import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RegistryInfo } from "@argent/update-core";

// The registry fetch and release-age probe now live in @argent/update-core
// (with their own low-level tests there). The checker only orchestrates them,
// so we mock that boundary and keep the real, pure pickInstallableTarget.
// vi.hoisted keeps the same fn instances across the vi.resetModules() below.
const { mockFetchRegistryInfo, mockDetectMinReleaseAgeMs } = vi.hoisted(() => ({
  mockFetchRegistryInfo: vi.fn<() => Promise<RegistryInfo | null>>(),
  mockDetectMinReleaseAgeMs: vi.fn<() => Promise<number>>(),
}));
vi.mock("@argent/update-core", async (importActual) => {
  const actual = await importActual<typeof import("@argent/update-core")>();
  return {
    ...actual,
    fetchRegistryInfo: mockFetchRegistryInfo,
    detectMinReleaseAgeMs: mockDetectMinReleaseAgeMs,
  };
});

let getUpdateState: typeof import("../src/utils/update-checker").getUpdateState;
let startUpdateChecker: typeof import("../src/utils/update-checker").startUpdateChecker;

const NOW = new Date("2026-06-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Build a parsed packument with a `latest` tag and a version → publish-time map. */
function registryInfo(latest: string, times: Record<string, string> = {}): RegistryInfo {
  return { latest: { version: latest, publishedAt: times[latest] ?? null }, times };
}

/** Convenience: a single-version packument with an optional publish time. */
function singleVersion(version: string, publishedAt?: string): RegistryInfo {
  return registryInfo(version, publishedAt ? { [version]: publishedAt } : {});
}

describe("update-checker", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetModules();
    vi.clearAllMocks();
    mockFetchRegistryInfo.mockReset();
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
  });

  it("detects an available, installable update on startup", async () => {
    mockFetchRegistryInfo.mockResolvedValue(singleVersion("99.0.0", "2020-01-01T00:00:00Z"));

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

    mockFetchRegistryInfo.mockResolvedValue(singleVersion(currentVersion, "2020-01-01T00:00:00Z"));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.updateInstallable).toBe(false);
    expect(state.latestVersion).toBe(currentVersion);

    handle.dispose();
  });

  it("keeps previous state when the registry is unreachable", async () => {
    mockFetchRegistryInfo.mockResolvedValue(null);

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.latestVersion).toBeNull();

    handle.dispose();
  });

  it("rechecks after the interval", async () => {
    mockFetchRegistryInfo.mockResolvedValue(singleVersion("99.0.0", "2020-01-01T00:00:00Z"));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetchRegistryInfo).toHaveBeenCalledTimes(1);

    // Advance 24 hours — should trigger another check.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 * 24);
    expect(mockFetchRegistryInfo).toHaveBeenCalledTimes(2);

    handle.dispose();
  });

  it("stops checking after dispose", async () => {
    mockFetchRegistryInfo.mockResolvedValue(singleVersion("99.0.0", "2020-01-01T00:00:00Z"));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetchRegistryInfo).toHaveBeenCalledTimes(1);

    handle.dispose();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockFetchRegistryInfo).toHaveBeenCalledTimes(1); // No additional calls after dispose.
  });

  // ── Semver comparison ─────────────────────────────────────────────

  it("does not flag update when running a newer local version", async () => {
    // npm returns 0.1.0 but local is ahead.
    mockFetchRegistryInfo.mockResolvedValue(singleVersion("0.1.0", "2020-01-01T00:00:00Z"));

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(false);
    expect(state.latestVersion).toBe("0.1.0");

    handle.dispose();
  });

  it("does not flag update for pre-release version strings", async () => {
    // npm returns a pre-release tag — should never be pushed.
    mockFetchRegistryInfo.mockResolvedValue(singleVersion("1.0.0-beta.1", "2020-01-01T00:00:00Z"));

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
    mockFetchRegistryInfo.mockResolvedValue(singleVersion("99.0.0", oneDayAgo));

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
    mockFetchRegistryInfo.mockResolvedValue(singleVersion("99.0.0", tenDaysAgo));

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
    mockFetchRegistryInfo.mockResolvedValue(
      registryInfo("99.0.0", { "98.0.0": tenDaysAgo, "99.0.0": oneDayAgo })
    );

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
    mockFetchRegistryInfo.mockResolvedValue(singleVersion("99.0.0")); // no time entry

    const handle = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);

    const state = getUpdateState();
    expect(state.updateAvailable).toBe(true);
    expect(state.updateInstallable).toBe(false);
    expect(state.installableVersion).toBeNull();
    expect(state.latestPublishedAt).toBeNull();

    handle.dispose();
  });

  // ── Double start guard ────────────────────────────────────────────

  it("clears previous interval when startUpdateChecker is called twice", async () => {
    mockFetchRegistryInfo.mockResolvedValue(singleVersion("99.0.0", "2020-01-01T00:00:00Z"));

    const handle1 = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetchRegistryInfo).toHaveBeenCalledTimes(1);

    // Start a second checker — should clear the first interval.
    const handle2 = startUpdateChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetchRegistryInfo).toHaveBeenCalledTimes(2);

    // Advance 24 hours — should trigger exactly 1 check (from handle2), not 2.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 * 24);
    expect(mockFetchRegistryInfo).toHaveBeenCalledTimes(3);

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
