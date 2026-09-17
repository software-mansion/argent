import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setFlag } from "@argent/configuration-core";
import {
  AUTO_SCREENSHOT_TOOLS,
  AUTO_SCREENSHOT_DELAY_MS_BY_TOOL,
  autoScreenshotEnabled,
  AUTO_DESCRIBE_TOOLS,
  autoDescribeEnabled,
  shouldAutoDescribe,
  containsSecretPlaceholder,
  getUdidFromArgs,
  normalizeToolName,
  shouldAutoScreenshot,
  getAutoScreenshotDelayMs,
} from "../src/auto-capture.js";

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
// autoScreenshotEnabled — driven by the off-by-default `disable-auto-screenshot`
// flag (auto-screenshot is on unless the flag is set).
// ---------------------------------------------------------------------------
describe("autoScreenshotEnabled", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-screenshot-home-")));
    tmpProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-screenshot-proj-")));
    // Marker so resolveProjectRoot stops at tmpProject instead of walking up.
    fs.writeFileSync(path.join(tmpProject, "package.json"), "{}");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  it("is on by default when the flag is unset", () => {
    expect(autoScreenshotEnabled({ homeDir: tmpHome, cwd: tmpProject })).toBe(true);
  });

  it("is off when the flag is enabled globally", () => {
    setFlag("disable-auto-screenshot", true, "global", { homeDir: tmpHome });
    expect(autoScreenshotEnabled({ homeDir: tmpHome, cwd: tmpProject })).toBe(false);
  });

  it("is off when the flag is enabled at project scope", () => {
    setFlag("disable-auto-screenshot", true, "project", { cwd: tmpProject });
    expect(autoScreenshotEnabled({ homeDir: tmpHome, cwd: tmpProject })).toBe(false);
  });

  it("project scope overrides a global disable (explicit false re-enables)", () => {
    setFlag("disable-auto-screenshot", true, "global", { homeDir: tmpHome });
    setFlag("disable-auto-screenshot", false, "project", { cwd: tmpProject });
    expect(autoScreenshotEnabled({ homeDir: tmpHome, cwd: tmpProject })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// autoDescribeEnabled / shouldAutoDescribe — the element tree appended after
// the auto-screenshot, opt-out via `disable-auto-describe`.
// ---------------------------------------------------------------------------
describe("autoDescribeEnabled", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-describe-home-")));
    tmpProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-describe-proj-")));
    fs.writeFileSync(path.join(tmpProject, "package.json"), "{}");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  it("is on by default when the flag is unset", () => {
    expect(autoDescribeEnabled({ homeDir: tmpHome, cwd: tmpProject })).toBe(true);
  });

  it("is off when the flag is enabled globally", () => {
    setFlag("disable-auto-describe", true, "global", { homeDir: tmpHome });
    expect(autoDescribeEnabled({ homeDir: tmpHome, cwd: tmpProject })).toBe(false);
  });

  it("is off when the flag is enabled at project scope", () => {
    setFlag("disable-auto-describe", true, "project", { cwd: tmpProject });
    expect(autoDescribeEnabled({ homeDir: tmpHome, cwd: tmpProject })).toBe(false);
  });
});

describe("shouldAutoDescribe", () => {
  it("is true for every listed tool, with or without a client prefix", () => {
    for (const tool of AUTO_DESCRIBE_TOOLS) {
      expect(shouldAutoDescribe(tool)).toBe(true);
      expect(shouldAutoDescribe(`mcp__argent__${tool}`)).toBe(true);
    }
  });

  it("never follows describe or screenshot, nor non-interaction tools", () => {
    expect(AUTO_DESCRIBE_TOOLS.has("describe")).toBe(false);
    expect(shouldAutoDescribe("describe")).toBe(false);
    expect(shouldAutoDescribe("mcp__argent__describe")).toBe(false);
    expect(shouldAutoDescribe("screenshot")).toBe(false);
    expect(shouldAutoDescribe("list-devices")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAutoScreenshotDelayMs
// ---------------------------------------------------------------------------
describe("getAutoScreenshotDelayMs", () => {
  const original = process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS;

  // Three of the tests below never set this themselves, and this package has no
  // ARGENT_*-stripping setup file the way tool-server does — so without this
  // they assert whatever the developer happens to have exported.
  beforeEach(() => {
    delete process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS;
  });

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
      "paste",
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

// ---------------------------------------------------------------------------
// containsSecretPlaceholder — the auto-screenshot must not render a just-typed
// secret back into model context as pixels
// ---------------------------------------------------------------------------
describe("containsSecretPlaceholder", () => {
  it("detects a placeholder in flat keyboard args", () => {
    expect(containsSecretPlaceholder({ udid: "X", text: "{{secret:APP_PASSWORD}}" })).toBe(true);
  });

  it("detects a placeholder nested in run-sequence steps", () => {
    expect(
      containsSecretPlaceholder({
        udid: "X",
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
          { tool: "keyboard", args: { text: "user@{{secret:PW}}" } },
        ],
      })
    ).toBe(true);
  });

  it("returns false for ordinary args", () => {
    expect(containsSecretPlaceholder({ udid: "X", text: "hello" })).toBe(false);
    expect(containsSecretPlaceholder(undefined)).toBe(false);
  });

  it("fails safe (true) on unserializable args", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(containsSecretPlaceholder(circular)).toBe(true);
  });

  it("does NOT cover the separate submit call the keyboard tool now forces", () => {
    // The asymmetry the skipped-screenshot note has to warn about. `keyboard`
    // rejects `{ text, key }`, so submitting after typing a secret is a second
    // call — and that call's own arguments carry no placeholder, so the scan
    // says false and the capture fires. `keyboard` is in AUTO_SCREENSHOT_TOOLS,
    // so the image is taken 300ms after the Enter lands, over a screen that may
    // still show the plaintext.
    expect(containsSecretPlaceholder({ udid: "X", key: "enter" })).toBe(false);
    expect(shouldAutoScreenshot("keyboard")).toBe(true);
    // The one form that keeps the skip across both steps: `run-sequence` is
    // scanned as a whole request, and is itself in AUTO_SCREENSHOT_TOOLS — so
    // without the scan reaching into its steps it would capture the same screen.
    expect(
      containsSecretPlaceholder({
        udid: "X",
        steps: [
          { tool: "keyboard", args: { text: "{{secret:PW}}" } },
          { tool: "keyboard", args: { key: "enter" } },
        ],
      })
    ).toBe(true);
    expect(shouldAutoScreenshot("run-sequence")).toBe(true);
  });
});
