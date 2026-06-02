import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AUTO_SCREENSHOT_TOOLS,
  AUTO_SCREENSHOT_DELAY_MS_BY_TOOL,
  autoScreenshotEnabled,
  getUdidFromArgs,
  normalizeToolName,
  shouldAutoScreenshot,
  getAutoScreenshotDelayMs,
} from "../src/auto-screenshot.js";

// ---------------------------------------------------------------------------
// normalizeToolName
// ---------------------------------------------------------------------------
describe("normalizeToolName", () => {
  it("returns name unchanged when no prefix", () => {
    expect(normalizeToolName("gesture-tap")).toBe("gesture-tap");
  });

  it("strips mcp__argent__ prefix", () => {
    expect(normalizeToolName("mcp__argent__gesture-tap")).toBe("gesture-tap");
  });

  it("strips any prefix ending with __", () => {
    expect(normalizeToolName("prefix__other__gesture-swipe")).toBe("gesture-swipe");
  });

  it("handles tool names with hyphens", () => {
    expect(normalizeToolName("mcp__argent__launch-app")).toBe("launch-app");
  });
});

// ---------------------------------------------------------------------------
// getUdidFromArgs
// ---------------------------------------------------------------------------
describe("getUdidFromArgs", () => {
  it("returns udid from a valid args object", () => {
    expect(getUdidFromArgs({ udid: "ABCD-1234" })).toBe("ABCD-1234");
  });

  it("returns undefined when args is undefined", () => {
    expect(getUdidFromArgs(undefined)).toBeUndefined();
  });

  it("returns undefined when args is null", () => {
    expect(getUdidFromArgs(null)).toBeUndefined();
  });

  it("returns undefined when args has no udid", () => {
    expect(getUdidFromArgs({ x: 0.5, y: 0.5 })).toBeUndefined();
  });

  it("returns undefined when udid is not a string", () => {
    expect(getUdidFromArgs({ udid: 42 })).toBeUndefined();
  });

  it("returns undefined for non-object args", () => {
    expect(getUdidFromArgs("string-arg")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// shouldAutoScreenshot
// ---------------------------------------------------------------------------
describe("shouldAutoScreenshot", () => {
  it("returns true for every tool in AUTO_SCREENSHOT_TOOLS", () => {
    for (const tool of AUTO_SCREENSHOT_TOOLS) {
      expect(shouldAutoScreenshot(tool)).toBe(true);
    }
  });

  it("returns true for prefixed tool names", () => {
    expect(shouldAutoScreenshot("mcp__argent__gesture-tap")).toBe(true);
    expect(shouldAutoScreenshot("mcp__argent__launch-app")).toBe(true);
  });

  it("returns false for screenshot", () => {
    expect(shouldAutoScreenshot("screenshot")).toBe(false);
  });

  it("returns false for prefixed screenshot", () => {
    expect(shouldAutoScreenshot("mcp__argent__screenshot")).toBe(false);
  });

  it("returns false for excluded tools", () => {
    expect(shouldAutoScreenshot("list-devices")).toBe(false);
    expect(shouldAutoScreenshot("boot-device")).toBe(false);
    expect(shouldAutoScreenshot("simulator-server")).toBe(false);
    expect(shouldAutoScreenshot("activate-sso")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// autoScreenshotEnabled
// ---------------------------------------------------------------------------
describe("autoScreenshotEnabled", () => {
  const original = process.env.ARGENT_AUTO_SCREENSHOT;

  afterEach(() => {
    if (original === undefined) delete process.env.ARGENT_AUTO_SCREENSHOT;
    else process.env.ARGENT_AUTO_SCREENSHOT = original;
  });

  it("returns true when env var is unset", () => {
    delete process.env.ARGENT_AUTO_SCREENSHOT;
    expect(autoScreenshotEnabled()).toBe(true);
  });

  it("returns true when env var is empty string", () => {
    process.env.ARGENT_AUTO_SCREENSHOT = "";
    expect(autoScreenshotEnabled()).toBe(true);
  });

  it('returns true when env var is "1"', () => {
    process.env.ARGENT_AUTO_SCREENSHOT = "1";
    expect(autoScreenshotEnabled()).toBe(true);
  });

  it('returns true when env var is "true" (case-insensitive)', () => {
    process.env.ARGENT_AUTO_SCREENSHOT = "True";
    expect(autoScreenshotEnabled()).toBe(true);
  });

  it('returns false when env var is "0"', () => {
    process.env.ARGENT_AUTO_SCREENSHOT = "0";
    expect(autoScreenshotEnabled()).toBe(false);
  });

  it('returns false when env var is "false"', () => {
    process.env.ARGENT_AUTO_SCREENSHOT = "false";
    expect(autoScreenshotEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAutoScreenshotDelayMs
// ---------------------------------------------------------------------------
describe("getAutoScreenshotDelayMs", () => {
  const original = process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS;
    else process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS = original;
  });

  it("returns configured delay for each tool in the delay map", () => {
    for (const [tool, expected] of Object.entries(AUTO_SCREENSHOT_DELAY_MS_BY_TOOL)) {
      expect(getAutoScreenshotDelayMs(tool)).toBe(expected);
    }
  });

  it("returns default 1400ms for an unknown tool", () => {
    expect(getAutoScreenshotDelayMs("some-new-tool")).toBe(1400);
  });

  it("normalizes prefixed tool names", () => {
    expect(getAutoScreenshotDelayMs("mcp__argent__gesture-tap")).toBe(
      AUTO_SCREENSHOT_DELAY_MS_BY_TOOL["gesture-tap"]
    );
    expect(getAutoScreenshotDelayMs("mcp__argent__launch-app")).toBe(
      AUTO_SCREENSHOT_DELAY_MS_BY_TOOL["launch-app"]
    );
  });

  it("uses env override as a floor", () => {
    process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS = "2000";
    expect(getAutoScreenshotDelayMs("describe")).toBe(2000); // 100 < 2000 → 2000
    expect(getAutoScreenshotDelayMs("keyboard")).toBe(2000); // 300 < 2000 → 2000
  });

  it("does not lower delay below the per-tool value", () => {
    process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS = "500";
    expect(getAutoScreenshotDelayMs("launch-app")).toBe(3000); // 3000 > 500 → 3000
  });

  it("ignores non-numeric env override", () => {
    process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS = "abc";
    expect(getAutoScreenshotDelayMs("gesture-tap")).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoScreenshot — unified tools trigger one screenshot regardless of platform
// ---------------------------------------------------------------------------
describe("shouldAutoScreenshot — unified surface", () => {
  it("returns false for the screenshot tool itself (prevents recursion)", () => {
    expect(shouldAutoScreenshot("screenshot")).toBe(false);
    expect(shouldAutoScreenshot("mcp__argent__screenshot")).toBe(false);
  });

  it("returns true for unified interaction tools", () => {
    for (const t of [
      "gesture-tap",
      "gesture-swipe",
      "button",
      "keyboard",
      "rotate",
      "launch-app",
      "restart-app",
      "open-url",
      "describe",
      "run-sequence",
    ]) {
      expect(shouldAutoScreenshot(t)).toBe(true);
    }
  });

  it("normalizes MCP-prefixed names before looking up the allow-list", () => {
    expect(shouldAutoScreenshot("mcp__argent__gesture-tap")).toBe(true);
    expect(shouldAutoScreenshot("mcp__argent__launch-app")).toBe(true);
  });
});
