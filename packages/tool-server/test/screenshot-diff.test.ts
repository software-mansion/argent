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

  it("hands OCR the decoded->normalized region scale for each image (diffPngFiles wiring)", async () => {
    // Same 2:1 aspect, different resolution: normalizeToCommonSize downscales the
    // larger baseline (480x240) to the current's size (240x120). diffPngFiles must
    // compute each image's decoded->normalized scale and pass it to the OCR pass,
    // so text bounds land in the shared pixel-diff coordinate space. Without this
    // wiring (the pre-fix screenshot-diff.ts) OCR is called with no region scales
    // and the half-image spurious "moved" change returns.
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 480, 240, { r: 0, g: 0, b: 0 });
    await writePng(currentPath, 240, 120, { r: 0, g: 0, b: 0 });

    await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

    expect(analyzeScreenshotTextChangesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineRegionScale: { x: 0.5, y: 0.5 },
        currentRegionScale: { x: 1, y: 1 },
      })
    );
  });

  it("hands OCR the normalized images, not the raw decoded ones (diffPngFiles wiring)", async () => {
    // Same 2:1 aspect, different resolution: normalizeToCommonSize downscales the
    // larger baseline (480x240) to the current's size (240x120). The OCR/font pass
    // rescales its text bounds into that shared 240x120 space, so it must also be
    // handed the NORMALIZED images to crop from. Feeding it the raw decoded
    // baseline (480x240) instead would crop the wrong region while the bounds are
    // already normalized. Pin that baselineImage/currentImage carry the normalized
    // dimensions; the raw baseline would surface here as width 480 / height 240.
    const dir = await makeTempDir();
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 480, 240, { r: 0, g: 0, b: 0 });
    await writePng(currentPath, 240, 120, { r: 0, g: 0, b: 0 });

    await diffPngFiles({ baselinePath, currentPath, outputDir: dir });

    expect(analyzeScreenshotTextChangesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineImage: expect.objectContaining({ width: 240, height: 120 }),
        currentImage: expect.objectContaining({ width: 240, height: 120 }),
      })
    );
  });
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
