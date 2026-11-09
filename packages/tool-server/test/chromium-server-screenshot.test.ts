import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { PNG } from "pngjs";
import { __resetSharpCacheForTests, captureScreenshot } from "../src/chromium-server/screenshot";
import type { ScreenshotOpts, ViewportSize } from "../src/chromium-server/types";
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
    type Rgba = [number, number, number, number];
    /** A real PNG, so the downscale path decodes and encodes for real. */
    function pngBase64(width: number, height: number, at: (x: number, y: number) => Rgba) {
      const png = new PNG({ width, height });
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          png.data.set(at(x, y), (y * width + x) * 4);
        }
      }
      return PNG.sync.write(png).toString("base64");
    }
    const flat = (width: number, height: number) =>
      pngBase64(width, height, () => [10, 20, 30, 255]);

    function cdpWith(capture: string, viewport: unknown) {
      const send = vi.fn(async (method: string, _params?: unknown, _timeoutMs?: number) => {
        if (method === "Runtime.evaluate") {
          if (viewport instanceof Error) throw viewport;
          return { result: { value: JSON.stringify(viewport) } };
        }
        return { data: capture };
      });
      return { cdp: { send } as unknown as CDPClient, send };
    }

    async function capture(
      cdp: CDPClient,
      opts: ScreenshotOpts = { cssPixels: true },
      known?: ViewportSize
    ) {
      const out = await captureScreenshot(
        { cdp, deviceId: "t", getViewport: known && (() => known) },
        opts
      );
      filesToCleanup.push(out.path);
      return fs.readFileSync(out.path);
    }
    const sizeOf = (bytes: Buffer) => {
      const png = PNG.sync.read(bytes);
      return [png.width, png.height];
    };

    it("downscales a 2x capture to the window's CSS size and never clips", async () => {
      const { cdp, send } = cdpWith(flat(2048, 1480), { w: 1024, h: 740, dpr: 2 });
      expect(sizeOf(await capture(cdp))).toEqual([1024, 740]);
      expect(send.mock.calls.filter(([method]) => method === "Page.captureScreenshot")).toEqual([
        ["Page.captureScreenshot", { format: "png", captureBeyondViewport: false }],
      ]);
    });

    it("averages each square of device pixels at a whole-number ratio", async () => {
      // Top-left 2x2 block is black and white half-and-half, so its average is mid grey.
      const shot = pngBase64(4, 2, (x, y) =>
        x < 2 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]
      );
      const { cdp } = cdpWith(shot, { w: 2, h: 1, dpr: 2 });
      const out = PNG.sync.read(await capture(cdp));
      expect([out.width, out.height]).toEqual([2, 1]);
      expect([...out.data.subarray(0, 4)]).toEqual([128, 128, 128, 255]);
      expect([...out.data.subarray(4, 8)]).toEqual([0, 0, 0, 255]);
    });

    it("averages any whole-number ratio, rounding to the nearest value", async () => {
      // One 120 among eight 30s: (240 + 120) / 9 = 40.
      const shot = pngBase64(6, 3, (x, y) =>
        x === 0 && y === 0 ? [120, 120, 120, 255] : [30, 30, 30, 255]
      );
      const { cdp } = cdpWith(shot, { w: 2, h: 1, dpr: 3 });
      const out = PNG.sync.read(await capture(cdp));
      expect([out.width, out.height]).toEqual([2, 1]);
      expect([...out.data.subarray(0, 4)]).toEqual([40, 40, 40, 255]);
      expect([...out.data.subarray(4, 8)]).toEqual([30, 30, 30, 255]);
    });

    it("takes each output pixel from its own square of device pixels, channel by channel", async () => {
      // Every 2x2 square is one colour and its four channels differ, so reading the
      // wrong row, column or channel changes a value.
      const colour = (x: number, y: number): Rgba => [
        10 + x * 20,
        100 + y * 30,
        200 - x * 10 - y * 15,
        255 - y,
      ];
      const shot = pngBase64(6, 6, (x, y) => colour(x >> 1, y >> 1));
      const { cdp } = cdpWith(shot, { w: 3, h: 3, dpr: 2 });
      const out = PNG.sync.read(await capture(cdp));
      expect([out.width, out.height]).toEqual([3, 3]);
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
          const at = (y * 3 + x) * 4;
          expect([...out.data.subarray(at, at + 4)]).toEqual(colour(x, y));
        }
      }
    });

    it("takes the ratio from the image, not devicePixelRatio", async () => {
      // dpr 3 fits the height but not the width: a ratio of 3 would give a 682-wide image.
      const { cdp } = cdpWith(flat(2048, 1305), { w: 683, h: 435, dpr: 3 });
      expect(sizeOf(await capture(cdp))).toEqual([683, 435]);
    });

    it("downscales a fractional ratio to the window's width", async () => {
      const { cdp } = cdpWith(flat(1536, 981), { w: 1024, h: 654, dpr: 1.5 });
      const out = PNG.sync.read(await capture(cdp));
      expect([out.width, out.height]).toEqual([1024, 654]);
      expect([...out.data.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    });

    it("keeps the image's aspect when a whole ratio does not fit the height", async () => {
      // 2x wide but one row short of 2x tall: lanczos, not a box that would drop the odd row.
      const { cdp } = cdpWith(flat(8, 5), { w: 4, h: 2, dpr: 2 });
      expect(sizeOf(await capture(cdp))).toEqual([4, 3]);
    });

    it("leaves a capture at one device pixel per CSS pixel untouched", async () => {
      const shot = flat(1024, 740);
      const { cdp } = cdpWith(shot, { w: 1024, h: 740, dpr: 1 });
      expect((await capture(cdp)).toString("base64")).toBe(shot);
    });

    it("leaves a capture not wider than the window untouched", async () => {
      // A zoomed-out page: more CSS pixels than the screen has device pixels.
      const shot = flat(1024, 740);
      const { cdp } = cdpWith(shot, { w: 1365, h: 986, dpr: 0.75 });
      expect((await capture(cdp)).toString("base64")).toBe(shot);
    });

    it("returns the capture when the window cannot be read", async () => {
      const shot = flat(2048, 1480);
      const { cdp } = cdpWith(shot, new Error("detached"));
      expect((await capture(cdp)).toString("base64")).toBe(shot);
    });

    it("uses the session's last ratio when the window cannot be read", async () => {
      const { cdp } = cdpWith(flat(2048, 1480), new Error("timed out"));
      const known = { width: 1024, height: 740, devicePixelRatio: 2 };
      expect(sizeOf(await capture(cdp, { cssPixels: true }, known))).toEqual([1024, 740]);
    });

    it("does not read the window when the session already knows it is at 1x", async () => {
      const shot = flat(1024, 740);
      const { cdp, send } = cdpWith(shot, new Error("would hang"));
      const known = { width: 1024, height: 740, devicePixelRatio: 1 };
      expect((await capture(cdp, { cssPixels: true }, known)).toString("base64")).toBe(shot);
      expect(send.mock.calls.map(([method]) => method)).toEqual(["Page.captureScreenshot"]);
    });

    it.each([
      ["wide", 4002, 2, { w: 2001, h: 1, dpr: 2 }],
      ["tall", 2, 4002, { w: 1, h: 2001, dpr: 2 }],
    ])("leaves a %s capture untouched above 2000 CSS pixels", async (_n, width, height, vp) => {
      const shot = flat(width, height);
      const { cdp } = cdpWith(shot, vp);
      expect((await capture(cdp)).toString("base64")).toBe(shot);
    });

    it("still downscales a window of exactly 2000 CSS pixels", async () => {
      const { cdp } = cdpWith(flat(4000, 2), { w: 2000, h: 1, dpr: 2 });
      expect(sizeOf(await capture(cdp))).toEqual([2000, 1]);
    });

    it("downscales before a rotation, while the image still matches the window", async () => {
      // Rotated first, a 2048x1480 capture is 1480 wide against a 1024 window: a wrong ratio.
      const Module = require("node:module") as { _load: (...args: unknown[]) => unknown };
      const originalLoad = Module._load;
      const sharpInputs: Buffer[] = [];
      const sharp = (input: Buffer) => {
        sharpInputs.push(input);
        const pipeline = {
          rotate: () => pipeline,
          resize: () => pipeline,
          png: () => pipeline,
          toBuffer: async () => input,
        };
        return pipeline;
      };
      Module._load = ((request: string, ...rest: unknown[]) =>
        request === "sharp"
          ? sharp
          : originalLoad.call(Module, request, ...rest)) as typeof Module._load;
      try {
        const { cdp } = cdpWith(flat(2048, 1480), { w: 1024, h: 740, dpr: 2 });
        await capture(cdp, { cssPixels: true, rotation: "LandscapeLeft" });
        expect(sharpInputs.map(sizeOf)).toEqual([[1024, 740]]);
      } finally {
        Module._load = originalLoad;
      }
    });

    it("gives the window read a short timeout, not the CDP default", async () => {
      const { cdp, send } = cdpWith(flat(2048, 1480), { w: 1024, h: 740, dpr: 2 });
      await capture(cdp);
      const read = send.mock.calls.find(([method]) => method === "Runtime.evaluate");
      expect(read?.[2]).toBe(150);
    });

    it("returns the capture when the window reports no size", async () => {
      const shot = flat(2048, 1480);
      const { cdp } = cdpWith(shot, { w: 0, h: 0, dpr: 2 });
      expect((await capture(cdp)).toString("base64")).toBe(shot);
    });

    it("returns the capture when it is not a readable PNG", async () => {
      const bytes = Buffer.from("not a png").toString("base64");
      const { cdp } = cdpWith(bytes, { w: 1024, h: 740, dpr: 2 });
      expect((await capture(cdp)).toString("base64")).toBe(bytes);
    });

    it("returns the capture when the PNG has a valid header but cannot be decoded", async () => {
      const header = Buffer.from(flat(2048, 1480), "base64").subarray(0, 33);
      const corrupt = Buffer.concat([header, Buffer.alloc(40)]).toString("base64");
      const { cdp } = cdpWith(corrupt, { w: 1024, h: 740, dpr: 2 });
      expect((await capture(cdp)).toString("base64")).toBe(corrupt);
    });

    it("does not touch the capture without cssPixels", async () => {
      const shot = flat(2048, 1480);
      const { cdp, send } = cdpWith(shot, { w: 1024, h: 740, dpr: 2 });
      expect((await capture(cdp, {})).toString("base64")).toBe(shot);
      expect(send.mock.calls.map(([method]) => method)).toEqual(["Page.captureScreenshot"]);
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
