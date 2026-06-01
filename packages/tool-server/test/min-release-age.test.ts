import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stable mock for child_process.exec so detection never spawns a real PM.
const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({ exec: mockExec }));

import { detectMinReleaseAgeMs, parseConfigValue } from "../src/utils/min-release-age";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const ENV = "ARGENT_MIN_RELEASE_AGE_DAYS";

/**
 * Drive the mocked exec: `byBin` maps a package-manager binary to the stdout it
 * should print for `<bin> config get <key>`. Unlisted binaries error (PM absent).
 */
function stubPmConfig(byBin: Record<string, string>) {
  mockExec.mockImplementation((cmd: string, _opts: unknown, cb: unknown) => {
    const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
    const bin = cmd.split(" ")[0]!;
    if (bin in byBin) {
      callback(null, byBin[bin]!, "");
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
  });

  it("rejects non-positive and non-finite values", () => {
    expect(parseConfigValue("0")).toBe(0);
    expect(parseConfigValue("-5")).toBe(0);
    expect(parseConfigValue("Infinity")).toBe(0);
    expect(parseConfigValue("not-a-number")).toBe(0);
  });
});

describe("detectMinReleaseAgeMs", () => {
  beforeEach(() => {
    mockExec.mockReset();
    delete process.env[ENV];
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  it("returns 0 when no package manager reports a policy", async () => {
    stubPmConfig({ npm: "undefined", pnpm: "null", yarn: "" });
    expect(await detectMinReleaseAgeMs()).toBe(0);
  });

  it("returns 0 when no package manager is installed", async () => {
    stubPmConfig({}); // every probe errors
    expect(await detectMinReleaseAgeMs()).toBe(0);
  });

  it("normalizes units and takes the most restrictive policy across PMs", async () => {
    // npm: 2 days; pnpm: 1440 min = 1 day; yarn: 60 min. Max = 2 days.
    stubPmConfig({ npm: "2", pnpm: "1440", yarn: "60" });
    expect(await detectMinReleaseAgeMs()).toBe(2 * DAY_MS);
  });

  it("reads pnpm minutes when npm has no policy", async () => {
    stubPmConfig({ npm: "undefined", pnpm: "30", yarn: "undefined" });
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
