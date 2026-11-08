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
    const out = await captureScreenshot({ cdp, deviceId: "test" });
    filesToCleanup.push(out.path);
    const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
  });

  describe("cssPixels", () => {
    const flatMetrics = (pageX: number, pageY: number) => ({
      cssLayoutViewport: { pageX, pageY },
      cssVisualViewport: { pageX, pageY, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 },
    });
    function cdpWith(viewport: unknown, metrics: unknown = flatMetrics(0, 0)) {
      const send = vi.fn(async (method: string) => {
        if (method === "Runtime.evaluate") {
          if (viewport instanceof Error) throw viewport;
          return { result: { value: JSON.stringify(viewport) } };
        }
        if (method === "Page.getLayoutMetrics") {
          if (metrics instanceof Error) throw metrics;
          return metrics;
        }
        return { data: ONE_PX_PNG_BASE64 };
      });
      return { cdp: { send } as unknown as CDPClient, send };
    }
    const captureArgs = (send: ReturnType<typeof vi.fn>) =>
      send.mock.calls.filter(([method]) => method === "Page.captureScreenshot").map(([, a]) => a);

    async function capture(cdp: CDPClient) {
      const out = await captureScreenshot({ cdp, deviceId: "t" }, { cssPixels: true });
      filesToCleanup.push(out.path);
    }

    it("clips to the window at 1 / devicePixelRatio", async () => {
      const { cdp, send } = cdpWith({ w: 1024, h: 740, dpr: 2 }, flatMetrics(0, 300));
      await capture(cdp);
      expect(captureArgs(send)).toEqual([
        {
          format: "png",
          captureBeyondViewport: false,
          clip: { x: 0, y: 300, width: 1024, height: 740, scale: 0.5 },
        },
      ]);
    });

    it("starts the clip from the layout viewport, so a right-to-left page is not blank", async () => {
      // A right-to-left page scrolled to its start: window.scrollX is 0, the document's left edge
      // is 4991 CSS pixels further left.
      const { cdp, send } = cdpWith(
        { w: 1024, h: 653, dpr: 2 },
        {
          cssLayoutViewport: { pageX: 4991, pageY: 0 },
          cssVisualViewport: { pageX: 0, pageY: 0, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 },
        }
      );
      await capture(cdp);
      expect(captureArgs(send)[0].clip).toMatchObject({ x: 4991, y: 0 });
    });

    it("takes a plain capture at one device pixel per CSS pixel", async () => {
      const { cdp, send } = cdpWith({ w: 1024, h: 740, dpr: 1 });
      await capture(cdp);
      expect(captureArgs(send)).toEqual([{ format: "png", captureBeyondViewport: false }]);
    });

    it("takes a plain capture when the window cannot be read", async () => {
      const { cdp, send } = cdpWith(new Error("detached"));
      await capture(cdp);
      expect(captureArgs(send)).toEqual([{ format: "png", captureBeyondViewport: false }]);
    });

    it("takes a plain capture when the page position cannot be read", async () => {
      const { cdp, send } = cdpWith({ w: 1024, h: 740, dpr: 2 }, new Error("detached"));
      await capture(cdp);
      expect(captureArgs(send)).toEqual([{ format: "png", captureBeyondViewport: false }]);
    });

    it.each([
      ["page zoom", { zoom: 1.5, scale: 1 }],
      ["pinch zoom", { zoom: 1, scale: 1.8 }],
      ["a protocol that reports neither", {}],
    ])("takes a plain capture under %s", async (_name, viewport) => {
      const { cdp, send } = cdpWith(
        { w: 682, h: 435, dpr: 3 },
        { cssLayoutViewport: { pageX: 0, pageY: 900 }, cssVisualViewport: viewport }
      );
      await capture(cdp);
      expect(captureArgs(send)).toEqual([{ format: "png", captureBeyondViewport: false }]);
    });

    it("discards the clip and takes a plain capture when the page moved during the capture", async () => {
      const positions = [flatMetrics(0, 2000), flatMetrics(0, 2400)];
      let reads = 0;
      const send = vi.fn(async (method: string) => {
        if (method === "Runtime.evaluate") {
          return { result: { value: JSON.stringify({ w: 1024, h: 653, dpr: 2 }) } };
        }
        if (method === "Page.getLayoutMetrics") return positions[reads++];
        return { data: ONE_PX_PNG_BASE64 };
      });
      await capture({ send } as unknown as CDPClient);
      const calls = captureArgs(send);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toHaveProperty("clip");
      expect(calls[1]).not.toHaveProperty("clip");
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
