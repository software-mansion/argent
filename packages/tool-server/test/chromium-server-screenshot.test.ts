import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { __resetSharpCacheForTests, captureScreenshot } from "../src/chromium-server/screenshot";
import type { CDPClient } from "../src/utils/debugger/cdp-client";

// 1×1 transparent PNG — small enough to embed inline, valid IHDR so the
// internal readPngSize check succeeds.
const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=";

function stubCdp(captureBase64 = ONE_PX_PNG_BASE64) {
  const send = vi.fn().mockResolvedValue({ data: captureBase64 });
  return { send } as unknown as CDPClient;
}

const filesToCleanup: string[] = [];

beforeEach(() => {
  __resetSharpCacheForTests();
});

afterEach(() => {
  for (const p of filesToCleanup.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
});

describe("chromium-server/screenshot", () => {
  it("writes a PNG and returns file:// url + absolute path", async () => {
    const cdp = stubCdp();
    const out = await captureScreenshot({ cdp, deviceId: "chromium-cdp-12345" });
    filesToCleanup.push(out.path);
    expect(out.path).toMatch(/argent-chromium-media/);
    expect(out.path).toMatch(/argent-screenshot-chromium-cdp-12345-/);
    expect(out.url).toBe(`file://${out.path}`);
    expect(fs.existsSync(out.path)).toBe(true);
  });

  it("calls Page.captureScreenshot with format png + no captureBeyondViewport", async () => {
    const cdp = stubCdp();
    await captureScreenshot({ cdp, deviceId: "test" });
    const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
  });

  it("uses the provided id in the filename", async () => {
    const cdp = stubCdp();
    const out = await captureScreenshot({ cdp, deviceId: "test" }, { id: "demo-123" });
    filesToCleanup.push(out.path);
    expect(out.path).toMatch(/demo-123\.png$/);
  });

  it("sanitizes deviceId for use in the filename", async () => {
    const cdp = stubCdp();
    // Slashes and colons would break the file path; the sanitizer replaces
    // them with underscores so a malformed id can't escape the media dir.
    const out = await captureScreenshot({ cdp, deviceId: "../../etc/passwd:bad" }, { id: "x" });
    filesToCleanup.push(out.path);
    expect(out.path).toMatch(/argent-screenshot-______etc_passwd_bad-x\.png/);
  });

  it("emits a one-time stderr warning when sharp is missing and downscale was requested", async () => {
    // Force the dynamic `require("sharp")` to throw — independent of whether
    // sharp is actually installed in the test environment — by stubbing
    // Module._resolveFilename to fail for "sharp" specifically.

    const Module = require("node:module") as {
      _resolveFilename: (...args: unknown[]) => string;
    };
    const original = Module._resolveFilename.bind(Module);
    Module._resolveFilename = ((request: string, ...rest: unknown[]) => {
      if (request === "sharp") throw new Error("forced sharp-missing for test");
      return original(request, ...rest);
    }) as typeof Module._resolveFilename;

    const cdp = stubCdp();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const out = await captureScreenshot({ cdp, deviceId: "test" }, { scale: 0.5 });
      filesToCleanup.push(out.path);
      const warnings = stderr.mock.calls
        .map((args) => String(args[0]))
        .filter((s) => s.includes("[chromium-screenshot]"));
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]).toMatch(/sharp is not installed/);
    } finally {
      stderr.mockRestore();
      Module._resolveFilename = original as typeof Module._resolveFilename;
    }
  });

  it("does not emit the sharp warning when no post-processing was requested", async () => {
    const cdp = stubCdp();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const out = await captureScreenshot({ cdp, deviceId: "test" });
      filesToCleanup.push(out.path);
      const warnings = stderr.mock.calls
        .map((args) => String(args[0]))
        .filter((s) => s.includes("[chromium-screenshot]"));
      expect(warnings.length).toBe(0);
    } finally {
      stderr.mockRestore();
    }
  });

  it("throws a clear error when CDP returns no data", async () => {
    const send = vi.fn().mockResolvedValue({});
    const cdp = { send } as unknown as CDPClient;
    await expect(captureScreenshot({ cdp, deviceId: "test" })).rejects.toThrow(/returned no data/);
  });
});
