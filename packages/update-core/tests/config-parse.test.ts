import { describe, it, expect } from "vitest";
import {
  parseConfigValue,
  parseBeforeAgeMs,
  parseYarnAgeGateMs,
  DAY_MS,
  MINUTE_MS,
} from "../src/config-parse";

const NOW = new Date("2026-06-01T00:00:00Z").getTime();

describe("parseConfigValue", () => {
  it("treats unset markers as no policy (0)", () => {
    expect(parseConfigValue("undefined")).toBe(0);
    expect(parseConfigValue("null")).toBe(0);
    expect(parseConfigValue("")).toBe(0);
    expect(parseConfigValue("   \n")).toBe(0);
  });

  it("parses positive numbers and ignores surrounding whitespace and quotes", () => {
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

describe("parseBeforeAgeMs", () => {
  it("treats unset markers as no policy (0)", () => {
    expect(parseBeforeAgeMs("undefined", NOW)).toBe(0);
    expect(parseBeforeAgeMs("null", NOW)).toBe(0);
    expect(parseBeforeAgeMs("", NOW)).toBe(0);
  });

  it("converts npm's effective `before` date into an equivalent age", () => {
    const twoDaysAgo = new Date(NOW - 2 * DAY_MS).toISOString();
    expect(parseBeforeAgeMs(twoDaysAgo, NOW)).toBe(2 * DAY_MS);
  });

  it("parses npm's human-readable date output with a trailing timezone label", () => {
    const value = "Fri Apr 03 2026 00:00:12 GMT+0200 (Central European Summer Time)";
    expect(parseBeforeAgeMs(value, Date.parse("2026-04-05T00:00:12+02:00"))).toBe(2 * DAY_MS);
  });

  it("returns 0 for invalid or future cutoff dates", () => {
    expect(parseBeforeAgeMs("not-a-date", NOW)).toBe(0);
    expect(parseBeforeAgeMs("2030-01-01T00:00:00Z", NOW)).toBe(0);
  });
});

describe("parseYarnAgeGateMs", () => {
  it("treats a bare number as minutes", () => {
    expect(parseYarnAgeGateMs("90")).toBe(90 * MINUTE_MS);
  });

  it("parses Yarn's quoted duration syntax with units", () => {
    expect(parseYarnAgeGateMs('"1d"')).toBe(DAY_MS);
    expect(parseYarnAgeGateMs("2w")).toBe(2 * 7 * DAY_MS);
  });

  it("returns 0 for unset or unparseable values", () => {
    expect(parseYarnAgeGateMs("undefined")).toBe(0);
    expect(parseYarnAgeGateMs("garbage")).toBe(0);
  });
});
