import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pickInstallableTarget } from "../src/pick-target";

const NOW = new Date("2026-06-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pickInstallableTarget", () => {
  it("returns the latest tag when there is no policy and it is a stable upgrade", () => {
    const target = pickInstallableTarget(
      { version: "2.0.0", publishedAt: null },
      { "1.0.0": "", "2.0.0": "" },
      "1.0.0",
      0
    );
    expect(target?.version).toBe("2.0.0");
  });

  it("returns null with no policy when the latest is not newer than current", () => {
    expect(
      pickInstallableTarget({ version: "1.0.0", publishedAt: null }, {}, "1.0.0", 0)
    ).toBeNull();
  });

  it("ignores prerelease latest with no policy", () => {
    expect(
      pickInstallableTarget({ version: "2.0.0-next.1", publishedAt: null }, {}, "1.0.0", 0)
    ).toBeNull();
  });

  it("treats current === null as nothing-installed (any stable release qualifies)", () => {
    const target = pickInstallableTarget({ version: "2.0.0", publishedAt: null }, {}, null, 0);
    expect(target?.version).toBe("2.0.0");
  });

  it("picks the newest eligible version when the latest publish is still held", () => {
    const oneDayAgo = new Date(NOW.getTime() - DAY_MS).toISOString();
    const tenDaysAgo = new Date(NOW.getTime() - 10 * DAY_MS).toISOString();
    const target = pickInstallableTarget(
      { version: "99.0.0", publishedAt: oneDayAgo },
      { "98.0.0": tenDaysAgo, "99.0.0": oneDayAgo },
      "1.0.0",
      7 * DAY_MS
    );
    expect(target?.version).toBe("98.0.0");
  });

  it("returns null under a policy when no version has aged past the gate", () => {
    const oneDayAgo = new Date(NOW.getTime() - DAY_MS).toISOString();
    const target = pickInstallableTarget(
      { version: "99.0.0", publishedAt: oneDayAgo },
      { "99.0.0": oneDayAgo },
      "1.0.0",
      7 * DAY_MS
    );
    expect(target).toBeNull();
  });

  it("skips prereleases and non-version keys when scanning under a policy", () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * DAY_MS).toISOString();
    const target = pickInstallableTarget(
      { version: "2.0.0", publishedAt: tenDaysAgo },
      { "created": tenDaysAgo, "2.0.0-next.1": tenDaysAgo, "2.0.0": tenDaysAgo },
      "1.0.0",
      7 * DAY_MS
    );
    expect(target?.version).toBe("2.0.0");
  });
});
