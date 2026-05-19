import { describe, expect, it } from "vitest";
import { formatScreenshotDiffSummary } from "../src/tools/screenshot-diff/screenshot-diff-summary";

describe("formatScreenshotDiffSummary", () => {
  it("emits overview, text, and region sections for unchanged screenshots", () => {
    const summary = formatScreenshotDiffSummary({
      totalPixels: 100,
      differentPixels: 0,
      mismatchPercentage: 0,
      imageSize: { width: 10, height: 10 },
      regions: [],
      textAnalysis: {
        status: "ok",
        provider: "ocr",
        changes: [],
      },
    });

    expect(summary).toContain("Screenshot diff summary");
    expect(summary).toContain("Overall:");
    expect(summary).toContain("- status: unchanged");
    expect(summary).toContain("- pixel_mismatch: 0% - no pixel change");
    expect(summary).toContain("- coordinates: normalized [0,1] (source=10x10)");
    expect(summary).toContain("Text changes:");
    expect(summary).toContain("- text_analysis: status=ok provider=ocr shown=0 total=0 omitted=0");
    expect(summary).toContain("Regions:");
  });

  it("merges movement and appearance evidence for the same text", () => {
    const summary = formatScreenshotDiffSummary({
      totalPixels: 100,
      differentPixels: 12,
      mismatchPercentage: 12,
      imageSize: { width: 1200, height: 2400 },
      regions: [],
      textAnalysis: {
        status: "ok",
        provider: "ocr",
        changes: [
          {
            kind: "moved",
            text: "A luxury villa just 400 meters from Jadro Beach on the be...",
            normalizedText: "a luxury villa just 400 meters from jadro beach on the be",
            baselineBounds: { x: 73, y: 1488, width: 1030, height: 177 },
            currentBounds: { x: 149, y: 1652, width: 826, height: 210 },
            delta: { x: 76, y: 164, width: -204, height: 33 },
            confidence: 0.92,
            source: "ocr",
            reasonCodes: ["exact_normalized_match", "position_delta"],
          },
          {
            kind: "font_changed",
            text: "A luxury villa just 400 meters from Jadro Beach on the be...",
            normalizedText: "a luxury villa just 400 meters from jadro beach on the be",
            baselineBounds: { x: 73, y: 1488, width: 1030, height: 177 },
            currentBounds: { x: 149, y: 1652, width: 826, height: 210 },
            confidence: 0.96,
            source: "ocr",
            reasonCodes: [
              "exact_normalized_match",
              "text_color_delta",
              "text_contrast_delta",
              "bbox_geometry_delta",
              "component_shape_delta",
            ],
          },
        ],
      },
    });

    expect(summary).toContain("- text_analysis: status=ok provider=ocr shown=1 total=1 omitted=0");
    expect(summary).toContain(
      '- Moved/restyled: "A luxury villa just 400 meters from Jadro Beach on the be..."'
    );
    expect(summary).toContain("  - from x=0.0608 y=0.62 w=0.8583 h=0.0738");
    expect(summary).toContain("  - to x=0.1242 y=0.6883 w=0.6883 h=0.0875");
    expect(summary).toContain("  - delta: dx=+0.0633 dy=+0.0683 dw=-0.17 dh=+0.0138");
    expect(summary).toContain("  - appearance: color, contrast, size/layout, shape/rendering");
    expect(summary).not.toContain("reason_codes");
    expect(summary).not.toContain("confidence=");
  });

  it("summarizes font evidence with semantic labels", () => {
    const summary = formatScreenshotDiffSummary({
      totalPixels: 100,
      differentPixels: 12,
      mismatchPercentage: 12,
      regions: [],
      textAnalysis: {
        status: "ok",
        provider: "ocr",
        changes: [
          {
            kind: "font_changed",
            text: "Header",
            baselineBounds: { x: 10, y: 20, width: 100, height: 24 },
            currentBounds: { x: 10, y: 20, width: 112, height: 28 },
            confidence: 0.823,
            source: "ocr",
            reasonCodes: [
              "exact_normalized_match",
              "bbox_geometry_delta",
              "stroke_width_delta",
              "text_color_delta",
              "ssim_delta",
            ],
          },
        ],
      },
    });

    expect(summary).toContain('- Restyled: "Header" (color, size/layout, weight/stroke, shape/rendering)');
  });

  it("distinguishes skipped and unavailable text analysis states", () => {
    const skipped = formatScreenshotDiffSummary({
      totalPixels: 2,
      differentPixels: 0,
      mismatchPercentage: 0,
      dimensionMismatch: {
        expected: { width: 2, height: 1 },
        actual: { width: 1, height: 2 },
      },
      regions: [],
      textAnalysis: {
        status: "skipped",
        provider: "ocr",
        changes: [],
      },
    });
    const unavailable = formatScreenshotDiffSummary({
      totalPixels: 100,
      differentPixels: 12,
      mismatchPercentage: 12,
      regions: [],
      textAnalysis: {
        status: "unavailable",
        provider: "ocr",
        changes: [],
      },
    });

    expect(skipped).toContain("- status: dimension_mismatch");
    expect(skipped).toContain("- text_analysis: status=skipped provider=ocr");
    expect(unavailable).toContain("- text_analysis: status=unavailable provider=ocr");
    expect(skipped).not.toContain("warnings");
    expect(unavailable).not.toContain("warnings");
  });

  it("preserves omitted counts for regions and text changes", () => {
    const summary = formatScreenshotDiffSummary({
      totalPixels: 100,
      differentPixels: 12,
      mismatchPercentage: 12,
      regions: Array.from({ length: 9 }, (_, index) => ({
        bounds: { x: index, y: index, width: 10, height: 10 },
        pixelCount: index + 1,
        averageColor: {
          delta: { r: 1, g: 2, b: 3 },
          dominantChange: { channel: "red", direction: "increase", magnitude: 1 },
        },
      })),
      textAnalysis: {
        status: "ok",
        provider: "ocr",
        changes: Array.from({ length: 11 }, (_, index) => ({
          kind: "appeared" as const,
          text: `Item ${index}`,
          currentBounds: { x: 10, y: index * 20, width: 100, height: 20 },
          confidence: 0.8,
          source: "ocr" as const,
          reasonCodes: ["missing_in_baseline" as const],
        })),
      },
    });

    expect(summary).toContain("- changed_areas: shown=8 total=9 omitted=1");
    expect(summary).toContain(
      "- text_analysis: status=ok provider=ocr shown=10 total=11 omitted=1"
    );
    expect(summary).toContain("- regions: shown=8 total=9 omitted=1");
    expect(summary).not.toContain("- Region 9:");
    expect(summary).not.toContain('- Appeared: "Item 10"');
    expect(summary).not.toContain("average_rgb_delta");
  });

  it("escapes and truncates quoted OCR text", () => {
    const summary = formatScreenshotDiffSummary({
      totalPixels: 100,
      differentPixels: 1,
      mismatchPercentage: 1,
      regions: [],
      textAnalysis: {
        status: "ok",
        provider: "ocr",
        changes: [
          {
            kind: "appeared",
            text: 'This "quoted" OCR text has     whitespace and is intentionally very long',
            currentBounds: { x: 10, y: 20, width: 100, height: 20 },
            confidence: 0.8,
            source: "ocr",
            reasonCodes: ["missing_in_baseline"],
          },
        ],
      },
    });

    expect(summary).toContain('"This \\"quoted\\" OCR text has whitespace and is intentionall..."');
  });
});
