import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectFontGeometryChange } from "../src/tools/screenshot-diff/font-diff";
import type { Rgb } from "../src/tools/screenshot-diff/screenshot-diff";
import {
  analyzeScreenshotTextChanges,
  analyzeTextRegions,
  normalizeTextForDiff,
} from "../src/tools/screenshot-diff/text-diff";

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

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  rgb?: Rgb;
}

describe("text diff", () => {
  beforeEach(() => {
    ocrMock.extractOcrTextBlocks.mockReset();
  });

  it("normalizes Unicode, whitespace, case, punctuation, and value symbols for matching", () => {
    expect(normalizeTextForDiff("  Wi\u2011Fi -- iCloud+, AND more!!  ")).toBe(
      "wi fi icloud and more"
    );
    expect(normalizeTextForDiff("\u212Bngstrom")).toBe("\u00e5ngstrom");
    expect(normalizeTextForDiff("10%")).toBe("10%");
    expect(normalizeTextForDiff("$ 10")).toBe("$10");
    expect(normalizeTextForDiff("A / B")).toBe("a/b");
    expect(normalizeTextForDiff("10%")).not.toBe(normalizeTextForDiff("10"));
  });

  it("detects moved text with OCR-noise tolerance near the same location", () => {
    const result = analyzeTextRegions({
      baselineRegions: [
        { text: "Settings", bounds: { x: 10, y: 20, width: 80, height: 18 }, confidence: 0.94 },
      ],
      currentRegions: [
        { text: "S3ttings", bounds: { x: 18, y: 20, width: 80, height: 18 }, confidence: 0.9 },
      ],
    });

    expect(result.changes).toMatchObject([
      {
        kind: "moved",
        source: "ocr",
        text: "Settings",
        delta: { x: 8, y: 0, width: 0, height: 0 },
        reasonCodes: ["ocr_noise_tolerated", "position_delta"],
      },
    ]);
    expect(result.changes[0]?.confidence).toBeGreaterThan(0.65);
  });

  it("does not match distant OCR-noisy same-text regions as movement", () => {
    const result = analyzeTextRegions({
      baselineRegions: [
        { text: "rnodel", bounds: { x: 10, y: 20, width: 80, height: 18 }, confidence: 0.94 },
      ],
      currentRegions: [
        { text: "model", bounds: { x: 220, y: 20, width: 80, height: 18 }, confidence: 0.94 },
      ],
    });

    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "disappeared", text: "rnodel" }),
        expect.objectContaining({ kind: "appeared", text: "model" }),
      ])
    );
    expect(result.changes.some((change) => change.kind === "moved")).toBe(false);
  });

  it("reports numeric value changes as content changes instead of OCR noise", () => {
    const result = analyzeTextRegions({
      baselineRegions: [
        { text: "Row 7 - scroll to test", bounds: { x: 10, y: 80, width: 190, height: 20 } },
      ],
      currentRegions: [
        { text: "Row 16 - scroll to test", bounds: { x: 10, y: 26, width: 200, height: 20 } },
      ],
    });

    expect(result.changes).toEqual([
      expect.objectContaining({
        kind: "content_changed",
        baselineText: "Row 7 - scroll to test",
        currentText: "Row 16 - scroll to test",
      }),
    ]);
  });

  it("detects appeared, disappeared, and same-location content changes", () => {
    const result = analyzeTextRegions({
      baselineRegions: [
        { text: "Account", bounds: { x: 10, y: 10, width: 70, height: 20 } },
        { text: "Battery", bounds: { x: 10, y: 80, width: 70, height: 20 } },
        { text: "Sign In", bounds: { x: 40, y: 200, width: 100, height: 30 } },
      ],
      currentRegions: [
        { text: "Account", bounds: { x: 10, y: 10, width: 70, height: 20 } },
        { text: "Privacy", bounds: { x: 10, y: 130, width: 70, height: 20 } },
        { text: "Continue", bounds: { x: 40, y: 200, width: 100, height: 30 } },
      ],
    });

    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "disappeared", text: "Battery" }),
        expect.objectContaining({ kind: "appeared", text: "Privacy" }),
        expect.objectContaining({
          kind: "content_changed",
          baselineText: "Sign In",
          currentText: "Continue",
          reasonCodes: ["normalized_text_changed", "same_location"],
        }),
      ])
    );
  });

  it("filters by confidence threshold before limiting returned primary changes", () => {
    const result = analyzeTextRegions({
      textChangeMinConfidence: 0.7,
      baselineRegions: [],
      currentRegions: [
        { text: "Below threshold", bounds: { x: 10, y: 10, width: 130, height: 20 }, confidence: 0.69 / 0.78 },
        { text: "Equal threshold", bounds: { x: 10, y: 40, width: 130, height: 20 }, confidence: 0.7 / 0.78 },
        { text: "Above threshold", bounds: { x: 10, y: 70, width: 130, height: 20 }, confidence: 0.71 / 0.78 },
        ...Array.from({ length: 12 }, (_, index) => ({
          text: `Noise ${index}`,
          bounds: { x: 10, y: 100 + index * 20, width: 130, height: 20 },
          confidence: 0.2,
        })),
      ],
    });

    expect(result.changes.map((change) => change.text)).toEqual([
      "Equal threshold",
      "Above threshold",
    ]);
  });

  it("emits movement and font evidence as separate raw changes", () => {
    const baselineBounds = { x: 10, y: 10, width: 24, height: 20 };
    const currentBounds = { x: 18, y: 10, width: 24, height: 20 };
    const baselineImage = makeImage(80, 50, glyphRects(baselineBounds, 2));
    const currentImage = makeImage(80, 50, glyphRects(currentBounds, 5));

    const result = analyzeTextRegions({
      baselineImage,
      currentImage,
      baselineRegions: [{ text: "Moved", bounds: baselineBounds, confidence: 0.96 }],
      currentRegions: [{ text: "Moved", bounds: currentBounds, confidence: 0.96 }],
    });

    expect(result.changes).toHaveLength(2);
    expect(result.changes).toEqual([
      expect.objectContaining({
        kind: "moved",
        text: "Moved",
        delta: { x: 8, y: 0, width: 0, height: 0 },
      }),
      expect.objectContaining({
        kind: "font_changed",
        text: "Moved",
        reasonCodes: expect.arrayContaining(["exact_normalized_match", "stroke_width_delta"]),
      }),
    ]);
    expect(result.changes[0]).not.toHaveProperty("font");
    expect(result.changes[1]?.font).toBeDefined();
  });

  it("detects pure text color changes as font evidence", () => {
    const glyphs = [
      { x: 7, y: 5, width: 2, height: 12 },
      { x: 17, y: 5, width: 2, height: 12 },
      { x: 7, y: 10, width: 12, height: 2 },
    ];
    const baselineImage = makeImage(28, 22, glyphs);
    const currentImage = makeImage(
      28,
      22,
      glyphs.map((rect) => ({ ...rect, rgb: { r: 210, g: 20, b: 20 } }))
    );

    const result = analyzeTextRegions({
      baselineImage,
      currentImage,
      baselineRegions: [
        { text: "Header", bounds: { x: 4, y: 3, width: 20, height: 16 }, confidence: 0.96 },
      ],
      currentRegions: [
        { text: "Header", bounds: { x: 4, y: 3, width: 20, height: 16 }, confidence: 0.96 },
      ],
    });

    expect(result.changes).toEqual([
      expect.objectContaining({
        kind: "font_changed",
        reasonCodes: expect.arrayContaining(["text_color_delta", "text_contrast_delta"]),
      }),
    ]);
  });

  it("does not treat a plain background luminance change as font geometry", () => {
    const glyphs = [
      { x: 7, y: 5, width: 2, height: 12 },
      { x: 17, y: 5, width: 2, height: 12 },
      { x: 7, y: 10, width: 12, height: 2 },
    ];
    const baselineImage = makeImage(28, 22, glyphs);
    const currentImage = makeImage(28, 22, glyphs, { r: 230, g: 230, b: 230 });

    const result = detectFontGeometryChange({
      baselineImage,
      currentImage,
      baselineRegion: { text: "Header", bounds: { x: 4, y: 3, width: 20, height: 16 } },
      currentRegion: { text: "Header", bounds: { x: 4, y: 3, width: 20, height: 16 } },
    });

    expect(result).toBeNull();
  });

  it("filters OCR text blocks fully above the top cutoff", () => {
    const result = analyzeTextRegions({
      ignoreTopPixels: 6,
      baselineRegions: [
        { text: "9:41", bounds: { x: 8, y: 0, width: 28, height: 5 }, confidence: 0.96 },
        { text: "Title", bounds: { x: 8, y: 20, width: 42, height: 10 }, confidence: 0.96 },
      ],
      currentRegions: [
        { text: "9:42", bounds: { x: 8, y: 0, width: 28, height: 5 }, confidence: 0.96 },
        { text: "Title", bounds: { x: 8, y: 20, width: 42, height: 10 }, confidence: 0.96 },
      ],
    });

    expect(result.changes).toEqual([]);
  });

  it("skips OCR when image pixels match", async () => {
    const result = await analyzeScreenshotTextChanges({
      baselinePath: "baseline.png",
      currentPath: "current.png",
      hasPixelDiff: false,
    });

    expect(result).toMatchObject({
      status: "skipped",
      provider: "ocr",
      changes: [],
    });
    expect(ocrMock.extractOcrTextBlocks).not.toHaveBeenCalled();
  });
});

function makeImage(
  width: number,
  height: number,
  rects: Rect[],
  background: Rgb = { r: 255, g: 255, b: 255 }
) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    data[offset] = background.r;
    data[offset + 1] = background.g;
    data[offset + 2] = background.b;
    data[offset + 3] = 255;
  }

  for (const rect of rects) {
    const rgb = rect.rgb ?? { r: 0, g: 0, b: 0 };
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const offset = (y * width + x) * 4;
        data[offset] = rgb.r;
        data[offset + 1] = rgb.g;
        data[offset + 2] = rgb.b;
        data[offset + 3] = 255;
      }
    }
  }

  return { width, height, data };
}

function glyphRects(bounds: Rect, strokeWidth: number): Rect[] {
  return [
    { x: bounds.x + 4, y: bounds.y + 4, width: strokeWidth, height: 12 },
    { x: bounds.x + 14, y: bounds.y + 4, width: strokeWidth, height: 12 },
    { x: bounds.x + 4, y: bounds.y + 9, width: 12 + strokeWidth, height: strokeWidth },
  ];
}
