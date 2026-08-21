import { afterEach, describe, expect, it } from "vitest";

import { getScreenshotScale } from "../src/utils/simulator-client";

// The default screenshot scale is what every iOS/Android/tvOS/Vega capture is
// downscaled to when the caller passes no `scale`, and an agent pays for it in
// context on every screenshot. These cases pin the value so it cannot drift
// without a deliberate edit here.

const ENV = "ARGENT_SCREENSHOT_SCALE";

afterEach(() => {
  delete process.env[ENV];
});

describe("getScreenshotScale", () => {
  it("defaults to 0.25 when the env var is unset", () => {
    delete process.env[ENV];
    expect(getScreenshotScale()).toBe(0.25);
  });

  it("uses a valid env override verbatim", () => {
    process.env[ENV] = "0.5";
    expect(getScreenshotScale()).toBe(0.5);
  });

  it("accepts the 1.0 boundary", () => {
    process.env[ENV] = "1";
    expect(getScreenshotScale()).toBe(1);
  });

  // Out-of-range and unparseable values fall back rather than producing a
  // zero-pixel or upscaled capture.
  it.each(["0", "-0.5", "1.5", "abc", ""])("falls back to 0.25 for %j", (value) => {
    process.env[ENV] = value;
    expect(getScreenshotScale()).toBe(0.25);
  });
});
