import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stable mock for child_process.exec so detection never spawns a real PM.
const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({ exec: mockExec }));

import {
  detectMinReleaseAgeMs,
  parseBeforeConfigValue,
  parseConfigValue,
} from "../src/utils/min-release-age";

const NOW = new Date("2026-06-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const ENV = "ARGENT_MIN_RELEASE_AGE_DAYS";

/**
 * Drive the mocked exec: `byCommand` maps a full `<pm> config get <key>`
 * command to the stdout it should print. Unlisted commands error (PM absent).
 */
function stubPmConfig(byCommand: Record<string, string>) {
  mockExec.mockImplementation((cmd: string, _opts: unknown, cb: unknown) => {
    const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
    if (cmd in byCommand) {
      callback(null, byCommand[cmd]!, "");
    } else {
      callback(new Error("command not found"), "", "");
    }
  });
}

describe("parseConfigValue", () => {
  it("treats unset markers as no policy (0)", () => {
    expect(parseConfigValue("undefined")).toBe(0);
    expect(parseConfigValue("null")).toBe(0);
    expect(parseConfigValue("")).toBe(0);
    expect(parseConfigValue("   \n")).toBe(0);
  });

  it("parses positive numbers and ignores surrounding whitespace", () => {
    expect(parseConfigValue("1440\n")).toBe(1440);
    expect(parseConfigValue("  7 ")).toBe(7);
    expect(parseConfigValue('"30"')).toBe(30);
  });

  it("rejects non-positive and non-finite values", () => {
    expect(parseConfigValue("0")).toBe(0);
    expect(parseConfigValue("-5")).toBe(0);
    expect(parseConfigValue("Infinity")).toBe(0);
    expect(parseConfigValue("not-a-number")).toBe(0);
  });
});

describe("parseBeforeConfigValue", () => {
  it("treats unset markers as no policy (0)", () => {
    expect(parseBeforeConfigValue("undefined", NOW.getTime())).toBe(0);
    expect(parseBeforeConfigValue("null", NOW.getTime())).toBe(0);
    expect(parseBeforeConfigValue("", NOW.getTime())).toBe(0);
  });

  it("converts npm's effective `before` date into an equivalent age", () => {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * DAY_MS).toISOString();
    expect(parseBeforeConfigValue(twoDaysAgo, NOW.getTime())).toBe(2 * DAY_MS);
  });

  it("parses npm's human-readable date output with a trailing timezone label", () => {
    const value = "Fri Apr 03 2026 00:00:12 GMT+0200 (Central European Summer Time)";
    expect(parseBeforeConfigValue(value, Date.parse("2026-04-05T00:00:12+02:00"))).toBe(2 * DAY_MS);
  });

  it("returns 0 for invalid or future cutoff dates", () => {
    expect(parseBeforeConfigValue("not-a-date", NOW.getTime())).toBe(0);
    expect(parseBeforeConfigValue("2030-01-01T00:00:00Z", NOW.getTime())).toBe(0);
  });
});

describe("detectMinReleaseAgeMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockExec.mockReset();
    delete process.env[ENV];
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env[ENV];
  });

  it("returns 0 when no package manager reports a policy", async () => {
    stubPmConfig({
      "npm config get before": "null",
      "pnpm config get minimumReleaseAge": "null",
      "yarn config get npmMinimalAgeGate": "",
    });
    expect(await detectMinReleaseAgeMs()).toBe(0);
  });

  it("returns 0 when no package manager is installed", async () => {
    stubPmConfig({}); // every probe errors
    expect(await detectMinReleaseAgeMs()).toBe(0);
  });

  it("normalizes units and takes the most restrictive policy across PMs", async () => {
    // npm: effective `before` 2 days ago; pnpm: 1440 min = 1 day; yarn: 60 min.
    const twoDaysAgo = new Date(NOW.getTime() - 2 * DAY_MS).toISOString();
    stubPmConfig({
      "npm config get before": twoDaysAgo,
      "pnpm config get minimumReleaseAge": "1440",
      "yarn config get npmMinimalAgeGate": "60",
    });
    expect(await detectMinReleaseAgeMs()).toBe(2 * DAY_MS);
  });

  it("reads npm's effective `before` cutoff when min-release-age is flattened away", async () => {
    const sevenDaysAgo = new Date(NOW.getTime() - 7 * DAY_MS).toISOString();
    stubPmConfig({
      "npm config get before": sevenDaysAgo,
      "pnpm config get minimumReleaseAge": "undefined",
      "yarn config get npmMinimalAgeGate": "undefined",
    });
    expect(await detectMinReleaseAgeMs()).toBe(7 * DAY_MS);
  });

  it("reads pnpm minutes when npm has no policy", async () => {
    stubPmConfig({
      "npm config get before": "null",
      "pnpm config get minimumReleaseAge": "30",
      "yarn config get npmMinimalAgeGate": "undefined",
    });
    expect(await detectMinReleaseAgeMs()).toBe(30 * MINUTE_MS);
  });

  it("honors the ARGENT_MIN_RELEASE_AGE_DAYS override and skips probing", async () => {
    process.env[ENV] = "3";
    expect(await detectMinReleaseAgeMs()).toBe(3 * DAY_MS);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("treats an invalid or non-positive override as no policy", async () => {
    process.env[ENV] = "0";
    expect(await detectMinReleaseAgeMs()).toBe(0);

    process.env[ENV] = "not-a-number";
    expect(await detectMinReleaseAgeMs()).toBe(0);

    expect(mockExec).not.toHaveBeenCalled();
  });
});
