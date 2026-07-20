import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OcrTextBlock } from "../src/tools/screenshot-diff/screenshot-diff-ocr";
import {
  analyzeScreenshotTextChanges,
  analyzeTextRegions,
  rescaleTextRegions,
  type TextRegion,
} from "../src/tools/screenshot-diff/text-diff";

// This suite guards the OCR coordinate-space fix WITHOUT any OCR engine. It
// never shells out to tesseract/python/PIL: OCR output is supplied directly as
// synthetic regions (and, for the pipeline test, via a mocked OCR module), so
// it runs as a pure unit test in CI where tesseract is not installed.

const ocrMock = vi.hoisted(() => ({
  extractOcrTextBlocks: vi.fn(),
}));

vi.mock("../src/tools/screenshot-diff/screenshot-diff-ocr", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/tools/screenshot-diff/screenshot-diff-ocr")>();
  return {
    ...actual,
    extractOcrTextBlocks: ocrMock.extractOcrTextBlocks,
  };
});

// "Settings" rendered at the same logical location, captured at two resolutions
// with the same 2:1 aspect ratio. The baseline file is twice the size of the
// current file, so its OCR bounds are exactly double the current bounds.
const SETTINGS_IN_BASELINE_480x240: TextRegion = {
  text: "Settings",
  confidence: 0.94,
  bounds: { x: 200, y: 100, width: 80, height: 18 },
  words: [
    { text: "Settings", confidence: 0.94, bounds: { x: 200, y: 100, width: 80, height: 18 } },
  ],
};
const SETTINGS_IN_CURRENT_240x120: TextRegion = {
  text: "Settings",
  confidence: 0.94,
  bounds: { x: 100, y: 50, width: 40, height: 9 },
  words: [{ text: "Settings", confidence: 0.94, bounds: { x: 100, y: 50, width: 40, height: 9 } }],
};

// Normalized common space (the smaller image's dimensions), which is what the
// pixel diff and the summary report against.
const NORMALIZED = { width: 240, height: 120 };
const BASELINE_TO_NORMALIZED = { x: 240 / 480, y: 120 / 240 };
const CURRENT_TO_NORMALIZED = { x: 1, y: 1 };

describe("screenshot-diff OCR coordinate space", () => {
  beforeEach(() => {
    ocrMock.extractOcrTextBlocks.mockReset();
  });

  it("rescales region and word bounds while leaving an identity scale untouched", () => {
    const regions: TextRegion[] = [structuredClone(SETTINGS_IN_BASELINE_480x240)];

    expect(rescaleTextRegions(regions, { x: 1, y: 1 })).toBe(regions);
    expect(rescaleTextRegions(regions)).toBe(regions);

    const scaled = rescaleTextRegions(regions, BASELINE_TO_NORMALIZED);
    expect(scaled[0].bounds).toEqual({ x: 100, y: 50, width: 40, height: 9 });
    expect(scaled[0].words?.[0].bounds).toEqual({ x: 100, y: 50, width: 40, height: 9 });
    // The source regions are not mutated.
    expect(regions[0].bounds).toEqual({ x: 200, y: 100, width: 80, height: 18 });
  });

  it("flags identical text in mismatched coordinate spaces as a spurious move (the bug)", () => {
    const result = analyzeTextRegions({
      baselineRegions: [SETTINGS_IN_BASELINE_480x240],
      currentRegions: [SETTINGS_IN_CURRENT_240x120],
    });

    const moved = result.changes.find((change) => change.kind === "moved");
    expect(moved).toBeDefined();
    // A half-image "move" of text that never actually moved.
    expect(Math.abs(moved?.delta?.x ?? 0)).toBeGreaterThanOrEqual(80);
    expect(Math.abs(moved?.delta?.y ?? 0)).toBeGreaterThanOrEqual(40);
  });

  it("reports no move once both OCR bound sets are rescaled into the common space", () => {
    const baseline = rescaleTextRegions([SETTINGS_IN_BASELINE_480x240], BASELINE_TO_NORMALIZED);
    const current = rescaleTextRegions([SETTINGS_IN_CURRENT_240x120], CURRENT_TO_NORMALIZED);

    const result = analyzeTextRegions({ baselineRegions: baseline, currentRegions: current });

    expect(result.status).toBe("ok");
    expect(result.changes.some((change) => change.kind === "moved")).toBe(false);
    expect(result.changes).toEqual([]);

    // The rescaled baseline bounds now coincide with the current bounds and sit
    // inside the normalized frame, so the summary cannot clamp a normalized
    // width to 1 (the compounding symptom of the bug).
    expect(baseline[0].bounds).toEqual(current[0].bounds);
    expect(baseline[0].bounds.x / NORMALIZED.width).toBeLessThan(1);
    expect(baseline[0].bounds.width / NORMALIZED.width).toBeLessThan(1);
    expect(baseline[0].bounds.y / NORMALIZED.height).toBeLessThan(1);
    expect(baseline[0].bounds.height / NORMALIZED.height).toBeLessThan(1);
  });

  it("does not invent a move when analyzeScreenshotTextChanges receives per-image scales", async () => {
    ocrMock.extractOcrTextBlocks.mockImplementation(async (imagePath: string) =>
      imagePath === "baseline.png"
        ? okOcr(SETTINGS_IN_BASELINE_480x240)
        : okOcr(SETTINGS_IN_CURRENT_240x120)
    );

    const result = await analyzeScreenshotTextChanges({
      baselinePath: "baseline.png",
      currentPath: "current.png",
      hasPixelDiff: true,
      baselineRegionScale: BASELINE_TO_NORMALIZED,
      currentRegionScale: CURRENT_TO_NORMALIZED,
    });

    expect(result.status).toBe("ok");
    expect(result.changes.some((change) => change.kind === "moved")).toBe(false);
    expect(result.changes).toEqual([]);
  });
});

function okOcr(region: TextRegion): {
  status: "ok";
  provider: "tesseract";
  blocks: OcrTextBlock[];
} {
  return {
    status: "ok",
    provider: "tesseract",
    blocks: [
      {
        text: region.text,
        confidence: region.confidence ?? 1,
        bounds: region.bounds,
        words: (region.words ?? []).map((word) => ({
          text: word.text,
          confidence: word.confidence,
          bounds: word.bounds,
          blockNum: 1,
          parNum: 1,
          lineNum: 1,
          wordNum: 1,
        })),
      },
    ],
  };
}
