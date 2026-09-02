import { describe, expect, it } from "vitest";
import { formatScreenshotDiffSummary } from "../src/tools/screenshot-diff/screenshot-diff-summary";
import { linesClaimingSize } from "./helpers/size-claims";

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

  it("labels no text change with a resolution, in any shape it renders", () => {
    // The bounds these lines carry are rescaled out of each image's own
    // coordinate space, so they are the stretch of the summary most tempting to
    // label with one — and the sweeps in screenshot-diff.test.ts run on fixtures
    // that detect no text at all, leaving every branch below unrendered.
    const bounds = { x: 10, y: 20, width: 100, height: 24 };
    const input: Parameters<typeof formatScreenshotDiffSummary>[0] = {
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
            text: "Moved",
            baselineBounds: bounds,
            currentBounds: { ...bounds, y: 40 },
            delta: { x: 0, y: 20, width: 0, height: 0 },
            confidence: 0.9,
            source: "ocr",
            reasonCodes: ["position_delta"],
          },
          {
            kind: "appeared",
            text: "Appeared",
            currentBounds: bounds,
            confidence: 0.9,
            source: "ocr",
            reasonCodes: [],
          },
          {
            kind: "disappeared",
            text: "Disappeared",
            baselineBounds: bounds,
            confidence: 0.9,
            source: "ocr",
            reasonCodes: [],
          },
          {
            kind: "content_changed",
            baselineText: "Before",
            currentText: "After",
            baselineBounds: bounds,
            currentBounds: bounds,
            confidence: 0.9,
            source: "ocr",
            reasonCodes: [],
          },
          {
            kind: "font_changed",
            text: "Restyled",
            baselineBounds: bounds,
            currentBounds: { ...bounds, height: 28 },
            confidence: 0.9,
            source: "ocr",
            reasonCodes: ["stroke_width_delta"],
          },
          // Movement and appearance for one text merge into a shape of their
          // own, the only one that renders the `- appearance:` bullet — the
          // kinds above reach it through neither branch.
          {
            kind: "moved",
            text: "Moved and restyled",
            normalizedText: "moved and restyled",
            baselineBounds: bounds,
            currentBounds: { ...bounds, y: 60 },
            delta: { x: 0, y: 40, width: 0, height: 0 },
            confidence: 0.9,
            source: "ocr",
            reasonCodes: ["exact_normalized_match", "position_delta"],
          },
          {
            kind: "font_changed",
            text: "Moved and restyled",
            normalizedText: "moved and restyled",
            baselineBounds: bounds,
            currentBounds: { ...bounds, y: 60 },
            confidence: 0.9,
            source: "ocr",
            reasonCodes: ["text_color_delta", "component_shape_delta"],
          },
        ],
      },
    };
    const summary = formatScreenshotDiffSummary(input);

    // Each branch actually rendered, or the sweep below passes over prose that
    // was never produced.
    expect(summary).toContain("- text_analysis: status=ok provider=ocr shown=6 total=6 omitted=0");
    for (const line of [
      "- Moved:",
      "- Appeared:",
      "- Disappeared:",
      "- Changed:",
      "- Restyled:",
      "- Moved/restyled:",
      "  - appearance: color, shape/rendering",
    ]) {
      expect(summary).toContain(line);
    }
    expect(linesClaimingSize(summary)).toEqual([]);

    // Every bounds and delta above renders a second way — raw device pixels,
    // taken when the result carries no usable size to normalize against. Those
    // are the numbers a resolution reads as a unit for, so sweep that shape too.
    const rawSummary = formatScreenshotDiffSummary({ ...input, imageSize: undefined });
    expect(rawSummary).toContain("x=10 y=20 w=100 h=24");
    expect(rawSummary).toContain("delta: dx=0 dy=+20 dw=0 dh=0");
    expect(linesClaimingSize(rawSummary)).toEqual([]);
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

    expect(summary).toContain(
      '- Restyled: "Header" (color, size/layout, weight/stroke, shape/rendering)'
    );
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
