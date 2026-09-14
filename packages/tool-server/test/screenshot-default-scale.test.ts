import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getScreenshotScale } from "../src/utils/simulator-client";

// Every iOS/Android/tvOS/Vega capture with no explicit `scale` lands on this
// value, and the agent pays for it in context on every screenshot.

const ENV = "ARGENT_SCREENSHOT_SCALE";

// The warning fires once per distinct value for the lifetime of the module, so
// every test that asserts on it needs a value no other test in this file uses.
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  delete process.env[ENV];
});

describe("getScreenshotScale", () => {
  it("defaults to 0.25 when the env var is unset", () => {
    delete process.env[ENV];
    expect(getScreenshotScale()).toBe(0.25);
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses a valid env override verbatim", () => {
    process.env[ENV] = "0.5";
    expect(getScreenshotScale()).toBe(0.5);
  });

  it("accepts the 1.0 boundary", () => {
    process.env[ENV] = "1";
    expect(getScreenshotScale()).toBe(1);
  });

  // The floor the `scale` parameter documents.
  it("accepts the 0.01 floor", () => {
    process.env[ENV] = "0.01";
    expect(getScreenshotScale()).toBe(0.01);
  });

  it.each(["0.009", "1e-3", "0.0001"])("falls back to 0.25 below the floor for %j", (value) => {
    process.env[ENV] = value;
    expect(getScreenshotScale()).toBe(0.25);
  });

  // Rejected rather than producing a zero-pixel or upscaled capture.
  it.each(["0", "-0.5", "1.5", "abc", ""])("falls back to 0.25 for %j", (value) => {
    process.env[ENV] = value;
    expect(getScreenshotScale()).toBe(0.25);
  });

  it("names the ignored value and the accepted range, once per value", () => {
    process.env[ENV] = "30";
    expect(getScreenshotScale()).toBe(0.25);
    expect(getScreenshotScale()).toBe(0.25);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("ARGENT_SCREENSHOT_SCALE=30");
    expect(warn.mock.calls[0][0]).toContain("between 0.01 and 1.0");
  });
});
