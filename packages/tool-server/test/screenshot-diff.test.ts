import fs from "fs/promises";
import os from "os";
import path from "path";
import { PNG } from "pngjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { diffPngFiles, type Rgb } from "../src/tools/screenshot-diff/screenshot-diff";

const analyzeScreenshotTextChangesMock = vi.hoisted(() =>
  vi.fn(async () => ({
    status: "ok" as const,
    provider: "ocr" as const,
    changes: [],
  }))
);

vi.mock("../src/tools/screenshot-diff/text-diff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/screenshot-diff/text-diff")>();
  return {
    ...actual,
    analyzeScreenshotTextChanges: analyzeScreenshotTextChangesMock,
  };
});

interface Pixel {
  x: number;
  y: number;
  rgb: Rgb;
}

describe("diffPngFiles", () => {
  beforeEach(() => {
    analyzeScreenshotTextChangesMock.mockReset();
    analyzeScreenshotTextChangesMock.mockResolvedValue({
      status: "ok",
      provider: "ocr",
      changes: [],
    });
  });

  it("reports matching PNGs and writes full-size and context diff artifacts", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 10, 10, { r: 100, g: 120, b: 140 });
    await writePng(currentPath, 10, 10, { r: 100, g: 120, b: 140 });

    const result = await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

    expect(result).toMatchObject({
      totalPixels: 100,
      differentPixels: 0,
      mismatchPercentage: 0,
      summary: expect.stringContaining("Screenshot diff summary"),
      imageSize: { width: 10, height: 10 },
      regions: [],
    });
    expect(result.diffPath).toBe(path.join(dir, "current-diff.png"));
    expect(result.contextDiffPath).toBe(path.join(dir, "current-context-diff.png"));

    const diff = PNG.sync.read(await fs.readFile(result.diffPath!));
    expect(diff.width).toBe(10);
    expect(diff.height).toBe(10);
    expect(readRgb(diff, 0, 0)).toEqual({ r: 170, g: 181, b: 192 });

    const contextDiff = PNG.sync.read(await fs.readFile(result.contextDiffPath!));
    expect(contextDiff.width).toBe(3);
    expect(contextDiff.height).toBe(3);
  });

  it("uses the hardcoded normalized threshold", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const belowThresholdPath = path.join(dir, "below.png");
    const aboveThresholdPath = path.join(dir, "above.png");
    await writePng(baselinePath, 1, 20, { r: 0, g: 0, b: 0 });
    await writePng(belowThresholdPath, 1, 20, { r: 0, g: 0, b: 0 }, [
      { x: 0, y: 10, rgb: { r: 25, g: 25, b: 25 } },
    ]);
    await writePng(aboveThresholdPath, 1, 20, { r: 0, g: 0, b: 0 }, [
      { x: 0, y: 10, rgb: { r: 26, g: 26, b: 26 } },
    ]);

    await expect(
      diffPngFiles({ baselinePath, currentPath: belowThresholdPath, outputDir: dir })
    ).resolves.toMatchObject({ differentPixels: 0 });
    await expect(
      diffPngFiles({ baselinePath, currentPath: aboveThresholdPath, outputDir: dir })
    ).resolves.toMatchObject({ differentPixels: 1 });
  });

  it("returns dimension mismatch details without writing diff artifacts", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 2, 1, { r: 0, g: 0, b: 0 });
    await writePng(currentPath, 1, 2, { r: 0, g: 0, b: 0 });

    const result = await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

    expect(result).toMatchObject({
      totalPixels: 2,
      differentPixels: 0,
      mismatchPercentage: 0,
      summary: expect.stringContaining("dimension_mismatch: expected=2x1 actual=1x2"),
      dimensionMismatch: {
        expected: { width: 2, height: 1 },
        actual: { width: 1, height: 2 },
      },
      regions: [],
      textAnalysis: { status: "skipped", provider: "ocr", changes: [] },
    });
    expect(result.diffPath).toBeUndefined();
    expect(result.contextDiffPath).toBeUndefined();
  });

  it("compares same-aspect screenshots of different resolutions instead of failing", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    // Same aspect ratio (0.5), different scale: a 0.3x-style saved baseline vs a
    // full-res live capture. These must be normalized and compared, not rejected.
    await writePng(baselinePath, 10, 20, { r: 30, g: 60, b: 90 });
    await writePng(currentPath, 20, 40, { r: 30, g: 60, b: 90 });

    const result = await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

    expect(result.dimensionMismatch).toBeUndefined();
    expect(result.summary).not.toContain("dimension_mismatch");
    expect(result.imageSize).toEqual({ width: 10, height: 20 });
    expect(result.diffPath).toBe(path.join(dir, "current-diff.png"));
    const diff = PNG.sync.read(await fs.readFile(result.diffPath!));
    expect(diff.width).toBe(10);
    expect(diff.height).toBe(20);
  });

  it("merges same-line fragments but keeps separate rows distinct", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const sameLinePath = path.join(dir, "same-line.png");
    const rowsPath = path.join(dir, "rows.png");
    await writePng(baselinePath, 80, 40, { r: 0, g: 0, b: 0 });
    await writePng(sameLinePath, 80, 40, { r: 0, g: 0, b: 0 }, [
      ...rectPixels(4, 12, 10, 8, { r: 255, g: 0, b: 0 }),
      ...rectPixels(30, 12, 10, 8, { r: 255, g: 0, b: 0 }),
      ...rectPixels(55, 12, 10, 8, { r: 255, g: 0, b: 0 }),
    ]);
    await writePng(rowsPath, 80, 40, { r: 0, g: 0, b: 0 }, [
      ...rectPixels(4, 4, 10, 8, { r: 255, g: 0, b: 0 }),
      ...rectPixels(24, 26, 10, 8, { r: 255, g: 0, b: 0 }),
    ]);

    const sameLine = await diffPngFiles({
      baselinePath,
      currentPath: sameLinePath,
      outputDir: dir,
    });
    const rows = await diffPngFiles({ baselinePath, currentPath: rowsPath, outputDir: dir });

    expect(sameLine.regions).toHaveLength(1);
    expect(sameLine.regions[0]).toMatchObject({
      bounds: { x: 4, y: 12, width: 61, height: 8 },
      pixelCount: 240,
    });
    expect(rows.regions).toHaveLength(2);
  });

  it("reports average colors and dominant luminance shifts per region", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 2, 20, { r: 0, g: 0, b: 0 }, [
      { x: 0, y: 10, rgb: { r: 20, g: 40, b: 60 } },
      { x: 1, y: 10, rgb: { r: 20, g: 40, b: 60 } },
    ]);
    await writePng(currentPath, 2, 20, { r: 0, g: 0, b: 0 }, [
      { x: 0, y: 10, rgb: { r: 80, g: 100, b: 120 } },
      { x: 1, y: 10, rgb: { r: 80, g: 100, b: 120 } },
    ]);

    const result = await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

    expect(result).toMatchObject({
      differentPixels: 2,
      regions: [
        {
          bounds: { x: 0, y: 10, width: 2, height: 1 },
          pixelCount: 2,
          averageColor: {
            delta: { r: 60, g: 60, b: 60 },
            dominantChange: { channel: "luminance", direction: "increase", magnitude: 60 },
          },
        },
      ],
    });
  });

  it("draws region rectangles and ignores changed pixels in the status-bar band", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 12, 100, { r: 20, g: 20, b: 20 });
    await writePng(currentPath, 12, 100, { r: 20, g: 20, b: 20 }, [
      ...rectPixels(0, 0, 12, 6, { r: 240, g: 240, b: 240 }),
      ...rectPixels(4, 20, 4, 4, { r: 255, g: 0, b: 0 }),
    ]);

    const result = await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

    expect(result.regions).toEqual([
      expect.objectContaining({
        bounds: { x: 4, y: 20, width: 4, height: 4 },
        pixelCount: 16,
      }),
    ]);
    const diff = PNG.sync.read(await fs.readFile(result.diffPath!));
    expect(readRgb(diff, 0, 0)).toEqual({ r: 247, g: 247, b: 247 });
    expect(readRgb(diff, 4, 17)).toEqual({ r: 255, g: 220, b: 0 });
    expect(readRgb(diff, 5, 21)).toEqual({ r: 0, g: 200, b: 0 });
  });

  it("compares the full image when the top mask is disabled", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 12, 100, { r: 20, g: 20, b: 20 });
    await writePng(
      currentPath,
      12,
      100,
      { r: 20, g: 20, b: 20 },
      rectPixels(0, 0, 12, 6, { r: 240, g: 240, b: 240 })
    );

    const result = await diffPngFiles({
      baselinePath,
      currentPath,
      outputDir: dir,
      topMask: "none",
    });

    expect(result).toMatchObject({
      differentPixels: 72,
      mismatchPercentage: 6,
      regions: [
        expect.objectContaining({
          bounds: { x: 0, y: 0, width: 12, height: 6 },
          pixelCount: 72,
        }),
      ],
    });
    expect(analyzeScreenshotTextChangesMock).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreTopPixels: 0 })
    );
  });

  it("does not mask an entire one-row image when the top mask is disabled", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 2, 1, { r: 0, g: 0, b: 0 });
    await writePng(currentPath, 2, 1, { r: 255, g: 255, b: 255 });

    const masked = await diffPngFiles({ baselinePath, currentPath, outputDir: dir });
    const unmasked = await diffPngFiles({
      baselinePath,
      currentPath,
      outputDir: dir,
      topMask: "none",
    });

    expect(masked).toMatchObject({ differentPixels: 0, mismatchPercentage: 0 });
    expect(unmasked).toMatchObject({ differentPixels: 2, mismatchPercentage: 100 });
  });

  it("colors changed pixels green when they brightened and red when they darkened", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 30, 60, { r: 20, g: 20, b: 20 }, [
      ...rectPixels(2, 20, 10, 10, { r: 240, g: 240, b: 240 }),
    ]);
    await writePng(currentPath, 30, 60, { r: 20, g: 20, b: 20 }, [
      ...rectPixels(18, 20, 10, 10, { r: 240, g: 240, b: 240 }),
    ]);

    const result = await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

    const diff = PNG.sync.read(await fs.readFile(result.diffPath!));

    expect(readRgb(diff, 6, 24)).toEqual({ r: 255, g: 0, b: 0 });
    expect(readRgb(diff, 22, 24)).toEqual({ r: 0, g: 200, b: 0 });
  });

  it("keeps pixel diff artifacts when text analysis fails unexpectedly", async () => {
    analyzeScreenshotTextChangesMock.mockRejectedValueOnce(new Error("ocr crashed"));
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 2, 20, { r: 0, g: 0, b: 0 });
    await writePng(currentPath, 2, 20, { r: 0, g: 0, b: 0 }, [
      { x: 1, y: 10, rgb: { r: 255, g: 0, b: 0 } },
    ]);

    const result = await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

    expect(result).toMatchObject({
      differentPixels: 1,
      textAnalysis: { status: "unavailable", provider: "ocr", changes: [] },
    });
    await expect(fs.stat(result.diffPath!)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(fs.stat(result.contextDiffPath!)).resolves.toMatchObject({
      size: expect.any(Number),
    });
  });

  it("passes the default text-change minimum confidence to OCR analysis", async () => {
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 2, 20, { r: 0, g: 0, b: 0 });
    await writePng(currentPath, 2, 20, { r: 0, g: 0, b: 0 }, [
      { x: 1, y: 10, rgb: { r: 255, g: 0, b: 0 } },
    ]);

    await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

    expect(analyzeScreenshotTextChangesMock).toHaveBeenCalledWith(
      expect.objectContaining({ textChangeMinConfidence: 0.7, ignoreTopPixels: 2 })
    );
  });

  // diffPngFiles normalizes two same-aspect, different-resolution screenshots to a
  // common size, then hands the OCR/font pass BOTH the normalized images and each
  // image's decoded->normalized region scale, so the rescaled text bounds and the
  // pixels they crop share the pixel-diff coordinate space. normalizeToCommonSize
  // only ever downscales the LARGER image and returns the smaller one untouched, so
  // for any one fixture only the downscaled side's wiring is load-bearing: its
  // normalized image and region scale differ from the raw decoded ones, so reverting
  // baselineImage/currentImage (or the matching region scale) to the decoded value
  // would surface the raw size and fail here. The untouched side's assertions hold
  // for both the decoded and normalized value, so we exercise BOTH directions to pin
  // both sides. Without this wiring the OCR pass would be handed the raw images and
  // no region scales -- the mismatch #442 fixed.
  it.each([
    {
      larger: "baseline",
      baseline: { width: 480, height: 240 },
      current: { width: 240, height: 120 },
      baselineRegionScale: { x: 0.5, y: 0.5 },
      currentRegionScale: { x: 1, y: 1 },
    },
    {
      larger: "current",
      baseline: { width: 240, height: 120 },
      current: { width: 480, height: 240 },
      baselineRegionScale: { x: 1, y: 1 },
      currentRegionScale: { x: 0.5, y: 0.5 },
    },
  ])(
    "hands OCR the normalized images and decoded->normalized region scales when the $larger image is downscaled (diffPngFiles wiring)",
    async ({ baseline, current, baselineRegionScale, currentRegionScale }) => {
      const dir = await makeTempDir();
      const baselinePath = path.join(dir, "baseline.png");
      const currentPath = path.join(dir, "current.png");
      await writePng(baselinePath, baseline.width, baseline.height, { r: 0, g: 0, b: 0 });
      await writePng(currentPath, current.width, current.height, { r: 0, g: 0, b: 0 });

      await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

      // Both images are normalized to the common 240x120 size; each region scale
      // maps that image's OCR bounds from its decoded size into the shared space.
      expect(analyzeScreenshotTextChangesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baselineImage: expect.objectContaining({ width: 240, height: 120 }),
          currentImage: expect.objectContaining({ width: 240, height: 120 }),
          baselineRegionScale,
          currentRegionScale,
        })
      );
    }
  );

  // diffPngFiles always calls the OCR/font pass, but tells it whether the pixel diff
  // found any changes via hasPixelDiff; the pass uses that to skip text analysis when
  // nothing moved. Pin the wiring in both directions -- identical images -> false, a
  // real pixel change -> true -- so hardcoding the source (e.g. to false, which would
  // silently disable text analysis for every real diff) fails here instead of staying
  // green.
  it.each([
    { name: "no pixel diff", changePixel: false, expected: false },
    { name: "a pixel diff", changePixel: true, expected: true },
  ])(
    "tells OCR whether the pixel diff found changes ($name -> hasPixelDiff=$expected)",
    async ({ changePixel, expected }) => {
      const dir = await makeTempDir();
      const baselinePath = path.join(dir, "baseline.png");
      const currentPath = path.join(dir, "current.png");
      await writePng(baselinePath, 2, 20, { r: 0, g: 0, b: 0 });
      await writePng(
        currentPath,
        2,
        20,
        { r: 0, g: 0, b: 0 },
        changePixel ? [{ x: 1, y: 10, rgb: { r: 255, g: 0, b: 0 } }] : []
      );

      await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

      expect(analyzeScreenshotTextChangesMock).toHaveBeenCalledWith(
        expect.objectContaining({ hasPixelDiff: expected })
      );
    }
  );
});

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-"));
}

async function writePng(
  filePath: string,
  width: number,
  height: number,
  fill: Rgb,
  pixels: Pixel[] = []
): Promise<void> {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      writeRgb(png, x, y, fill);
    }
  }

  for (const pixel of pixels) {
    writeRgb(png, pixel.x, pixel.y, pixel.rgb);
  }

  await fs.writeFile(filePath, PNG.sync.write(png));
}

function rectPixels(x: number, y: number, width: number, height: number, rgb: Rgb): Pixel[] {
  const pixels: Pixel[] = [];
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) {
      pixels.push({ x: px, y: py, rgb });
    }
  }
  return pixels;
}

function writeRgb(png: PNG, x: number, y: number, rgb: Rgb): void {
  const offset = (png.width * y + x) * 4;
  png.data[offset] = rgb.r;
  png.data[offset + 1] = rgb.g;
  png.data[offset + 2] = rgb.b;
  png.data[offset + 3] = 255;
}

function readRgb(png: PNG, x: number, y: number): Rgb {
  const offset = (png.width * y + x) * 4;
  return {
    r: png.data[offset],
    g: png.data[offset + 1],
    b: png.data[offset + 2],
  };
}
