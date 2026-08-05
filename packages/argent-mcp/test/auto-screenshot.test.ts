import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setFlag } from "@argent/configuration-core";
import {
  AUTO_SCREENSHOT_TOOLS,
  AUTO_SCREENSHOT_DELAY_MS_BY_TOOL,
  autoScreenshotEnabled,
  containsSecretPlaceholder,
  getUdidFromArgs,
  normalizeToolName,
  shouldAutoScreenshot,
  getAutoScreenshotDelayMs,
  autoScreenshotContext,
  renderAutoScreenshot,
} from "../src/auto-screenshot.js";
import { toMcpContent } from "../src/content.js";
import { ARTIFACT_MARKER, artifactsRoot, type ArtifactHandle } from "@argent/tools-client";

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
});

// ---------------------------------------------------------------------------
// autoScreenshotContext — the explicit-vs-auto durability boundary
// ---------------------------------------------------------------------------
describe("autoScreenshotContext", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);

  let cache: string; // ARGENT_ARTIFACTS_DIR (the disposable temp cache)
  let projectRoot: string; // the client's project, where a durable PNG would land
  let originalCwd: string;

  beforeEach(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), "argent-artifacts-"));
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-proj-")));
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}"); // the project marker
    process.env.ARGENT_ARTIFACTS_DIR = cache;
    originalCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.ARGENT_ARTIFACTS_DIR;
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  // A screenshot handle exactly as the tool-server emits one: tagged for durable
  // saving under the project's `.argent/screenshots/`.
  function shotHandle(): ArtifactHandle {
    return {
      [ARTIFACT_MARKER]: true,
      id: "shot",
      filename: "screenshot-SIM-1785400000000.png",
      mimeType: "image/png",
      size: PNG.length,
      saveDir: ".argent/screenshots",
    };
  }

  // The same handle, but pointing at a real file on this host — what a
  // co-located tool-server emits. Lets the render run with no fetch at all, so
  // `renderAutoScreenshot` can be called exactly as mcp-server.ts calls it.
  function coLocatedShotHandle(): ArtifactHandle {
    const hostPath = path.join(cache, "backend-capture.png");
    fs.writeFileSync(hostPath, PNG);
    const st = fs.statSync(hostPath);
    return { ...shotHandle(), hostPath, size: st.size, mtimeMs: st.mtimeMs };
  }

  const fetchImpl = (async () => ({
    ok: true,
    arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
  })) as unknown as typeof fetch;

  function screenshotsDir(): string[] {
    try {
      return fs.readdirSync(path.join(projectRoot, ".argent", "screenshots"));
    } catch {
      return [];
    }
  }

  it("carries the request identity through unchanged", () => {
    const ctx = autoScreenshotContext({
      toolsUrl: "http://remote:3001",
      authToken: "tok",
      udid: "SIM-1",
    });
    expect(ctx.toolsUrl).toBe("http://remote:3001");
    expect(ctx.authToken).toBe("tok");
    expect(ctx.deviceId).toBe("SIM-1");
  });

  it("renders an auto-screenshot into the temp cache, leaving the project untouched", async () => {
    // Driven through `renderAutoScreenshot`, the function `mcp-server.ts`
    // actually calls — not through a context assembled here. A test that builds
    // its own context proves the helper works and says nothing about whether
    // the auto-screenshot path still uses it.
    const blocks = await renderAutoScreenshot(
      { image: coLocatedShotHandle() },
      { toolsUrl: "http://remote:3001", udid: "SIM-1" }
    );

    expect(screenshotsDir()).toEqual([]);
    const savedText = blocks.find((b) => b.type === "text");
    expect(
      savedText?.type === "text" && savedText.text.startsWith(`Saved: ${artifactsRoot()}`)
    ).toBe(true);
    expect(blocks.some((b) => b.type === "image")).toBe(true);
  });

  it("keeps an auto-screenshot in the temp cache, leaving the project untouched", async () => {
    const blocks = await toMcpContent({ image: shotHandle() }, "image", {
      ...autoScreenshotContext({ toolsUrl: "http://remote:3001", udid: "SIM-1" }),
      fetchImpl,
    });

    // Nothing written into the working tree — not even the directory.
    expect(screenshotsDir()).toEqual([]);
    const saved = blocks.find((b) => b.type === "text");
    expect(saved?.type === "text" && saved.text.startsWith(`Saved: ${artifactsRoot()}`)).toBe(true);
    // Suppressing persistence must not suppress the inline image.
    expect(blocks.some((b) => b.type === "image")).toBe(true);
  });

  it("an explicitly requested screenshot with the same handle DOES reach the project", async () => {
    // The discriminator: identical artifact and identical rendering path; only
    // the context differs, and only this one persists.
    const blocks = await toMcpContent({ image: shotHandle() }, "image", {
      toolsUrl: "http://remote:3001",
      deviceId: "SIM-1",
      fetchImpl,
    });

    expect(screenshotsDir()).toEqual(["screenshot-SIM-1785400000000.png"]);
    const saved = blocks.find((b) => b.type === "text");
    expect(
      saved?.type === "text" &&
        saved.text.startsWith(`Saved: ${path.join(projectRoot, ".argent", "screenshots")}`)
    ).toBe(true);
  });
});
