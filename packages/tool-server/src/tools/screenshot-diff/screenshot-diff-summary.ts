import type { DiffBounds, DiffRegion, PngDiffResult, Size } from "./screenshot-diff";
import type { TextChange } from "./text-diff";

const MAX_SUMMARY_REGIONS = 8;
const MAX_SUMMARY_TEXT_CHANGES = 10;

type ScreenshotDiffSummaryInput = Omit<PngDiffResult, "summary">;
type TextSummaryChange = TextChange & {
  appearanceChange?: TextChange;
};
type SummaryStatus = "unchanged" | "changed" | "dimension_mismatch" | "unknown";
type CoordinateSpace = { imageSize: Size } | undefined;

export function formatScreenshotDiffSummary(result: ScreenshotDiffSummaryInput): string {
  const status = screenshotDiffStatus(result);
  const textChanges =
    result.textAnalysis?.status === "ok"
      ? mergeTextChangesForSummary(result.textAnalysis.changes)
      : [];
  const shownTextChanges = textChanges.slice(0, MAX_SUMMARY_TEXT_CHANGES);
  const shownRegions = result.regions.slice(0, MAX_SUMMARY_REGIONS);
  const coordinateSpace = coordinateSpaceForSummary(result.imageSize);

  const lines: string[] = ["Screenshot diff summary", "", "Overall:"];
  lines.push(`- status: ${status}`);

  if (result.dimensionMismatch) {
    lines.push(
      `- dimension_mismatch: expected=${formatSize(result.dimensionMismatch.expected)} actual=${formatSize(result.dimensionMismatch.actual)}`
    );
  } else {
    lines.push(
      `- pixel_mismatch: ${formatPercentage(result.mismatchPercentage)} - ${describeMismatch(result)}`
    );
  }

  lines.push(
    `- changed_areas: shown=${formatInteger(shownRegions.length)} total=${formatInteger(result.regions.length)} omitted=${formatInteger(Math.max(0, result.regions.length - shownRegions.length))}`
  );

  if (result.diffPath || result.contextDiffPath) {
    lines.push(`- diff_images:`);
    if (result.diffPath) lines.push(`  - diff: ${result.diffPath}`);
    if (result.contextDiffPath) lines.push(`  - context: ${result.contextDiffPath}`);
    lines.push(
      `  - legend: green=pixel brighter in current, red=pixel darker in current, yellow rectangles outline changed regions`
    );
  }

  lines.push("", "Text changes:");
  if (result.textAnalysis) {
    if (result.textAnalysis.status === "ok") {
      lines.push(
        `- text_analysis: status=ok provider=${result.textAnalysis.provider} shown=${formatInteger(shownTextChanges.length)} total=${formatInteger(textChanges.length)} omitted=${formatInteger(Math.max(0, textChanges.length - shownTextChanges.length))}`
      );
      if (shownTextChanges.length === 0) {
        lines.push(`- None detected.`);
      } else {
        for (const change of shownTextChanges) {
          lines.push(...formatTextChange(change, coordinateSpace));
        }
      }
    } else {
      lines.push(
        `- text_analysis: status=${result.textAnalysis.status} provider=${result.textAnalysis.provider}`
      );
    }
  } else {
    lines.push(`- text_analysis: not_run`);
  }

  lines.push("", "Regions:");
  lines.push(
    `- regions: shown=${formatInteger(shownRegions.length)} total=${formatInteger(result.regions.length)} omitted=${formatInteger(Math.max(0, result.regions.length - shownRegions.length))}`
  );
  if (shownRegions.length === 0) {
    lines.push(`- None detected.`);
  } else {
    for (const [index, region] of shownRegions.entries()) {
      lines.push(`- Region ${index + 1}: ${formatRegion(region, coordinateSpace)}`);
    }
  }

  return lines.join("\n");
}

function screenshotDiffStatus(result: ScreenshotDiffSummaryInput): SummaryStatus {
  if (result.dimensionMismatch) return "dimension_mismatch";
  if (
    !Number.isFinite(result.totalPixels) ||
    !Number.isFinite(result.differentPixels) ||
    !Number.isFinite(result.mismatchPercentage)
  ) {
    return "unknown";
  }
  if (result.differentPixels > 0) return "changed";
  if (result.textAnalysis?.status === "ok" && result.textAnalysis.changes.length > 0) {
    return "changed";
  }
  return "unchanged";
}

function formatSize(size: { width: number; height: number }): string {
  return `${formatInteger(size.width)}x${formatInteger(size.height)}`;
}

function describeMismatch(result: ScreenshotDiffSummaryInput): string {
  if (result.differentPixels === 0) return "no pixel change";
  const severity =
    result.mismatchPercentage < 5
      ? "minor"
      : result.mismatchPercentage < 10
        ? "moderate"
        : result.mismatchPercentage < 20
          ? "significant"
          : "large";
  const scope = result.regions.length <= 5 ? "localized" : "broad";
  return `${severity} ${scope} visual change`;
}

function formatRegion(region: DiffRegion, coordinateSpace: CoordinateSpace): string {
  return `${formatBounds(region.bounds, coordinateSpace)} - changed_pixels=${formatInteger(region.pixelCount)}`;
}

function mergeTextChangesForSummary(changes: TextChange[]): TextSummaryChange[] {
  const merged: TextSummaryChange[] = [];
  const consumed = new Set<number>();

  for (let index = 0; index < changes.length; index++) {
    if (consumed.has(index)) continue;
    const change = changes[index];

    if (change.kind === "moved") {
      const appearanceIndex = changes.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          !consumed.has(candidateIndex) &&
          candidate.kind === "font_changed" &&
          isSameTextLocationChange(change, candidate)
      );

      if (appearanceIndex !== -1) {
        consumed.add(appearanceIndex);
        merged.push({
          ...change,
          confidence: Math.min(change.confidence, changes[appearanceIndex].confidence),
          reasonCodes: [...change.reasonCodes, ...changes[appearanceIndex].reasonCodes],
          appearanceChange: changes[appearanceIndex],
        });
        continue;
      }
    }

    merged.push(change);
  }

  return merged;
}

function isSameTextLocationChange(left: TextChange, right: TextChange): boolean {
  const leftText = left.normalizedText ?? normalizeSummaryText(left.text);
  const rightText = right.normalizedText ?? normalizeSummaryText(right.text);
  return (
    leftText.length > 0 &&
    leftText === rightText &&
    sameBounds(left.baselineBounds, right.baselineBounds) &&
    sameBounds(left.currentBounds, right.currentBounds)
  );
}

function sameBounds(left: DiffBounds | undefined, right: DiffBounds | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function normalizeSummaryText(text: string | undefined): string {
  return text?.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US") ?? "";
}

function formatTextChange(change: TextSummaryChange, coordinateSpace: CoordinateSpace): string[] {
  switch (change.kind) {
    case "moved":
      return [
        `- ${formatMovedLabel(change)}: ${formatQuotedText(change.text)}`,
        ...formatMoveBounds(change, coordinateSpace),
        change.delta ? `  - delta: ${formatDelta(change.delta, coordinateSpace)}` : undefined,
        formatAppearanceDetail(change),
      ].filter((line): line is string => Boolean(line));
    case "appeared":
      return [
        `- Appeared: ${formatQuotedText(change.text)}`,
        change.currentBounds
          ? `  - at ${formatBounds(change.currentBounds, coordinateSpace)}`
          : undefined,
      ].filter((line): line is string => Boolean(line));
    case "disappeared":
      return [
        `- Disappeared: ${formatQuotedText(change.text)}`,
        change.baselineBounds
          ? `  - from ${formatBounds(change.baselineBounds, coordinateSpace)}`
          : undefined,
      ].filter((line): line is string => Boolean(line));
    case "content_changed":
      return [
        `- Changed: ${formatQuotedText(change.baselineText)} -> ${formatQuotedText(change.currentText)}`,
        change.baselineBounds
          ? `  - from ${formatBounds(change.baselineBounds, coordinateSpace)}`
          : undefined,
        change.currentBounds
          ? `  - to ${formatBounds(change.currentBounds, coordinateSpace)}`
          : undefined,
      ].filter((line): line is string => Boolean(line));
    case "font_changed":
      return [
        `- Restyled: ${formatQuotedText(change.text)}${formatAppearanceLabelSuffix(change)}`,
        change.baselineBounds
          ? `  - from ${formatBounds(change.baselineBounds, coordinateSpace)}`
          : undefined,
        change.currentBounds
          ? `  - to ${formatBounds(change.currentBounds, coordinateSpace)}`
          : undefined,
      ].filter((line): line is string => Boolean(line));
    default:
      return [
        `- ${change.kind}: ${formatQuotedText(change.text ?? change.currentText ?? change.baselineText)}`,
      ];
  }
}

function formatMoveBounds(change: TextChange, coordinateSpace: CoordinateSpace): string[] {
  const parts: string[] = [];
  if (change.baselineBounds) {
    parts.push(`  - from ${formatBounds(change.baselineBounds, coordinateSpace)}`);
  }
  if (change.currentBounds) {
    parts.push(`  - to ${formatBounds(change.currentBounds, coordinateSpace)}`);
  }
  return parts;
}

function formatMovedLabel(change: TextSummaryChange): string {
  return formatAppearanceFields(change).length > 0 ? "Moved/restyled" : "Moved";
}

function formatAppearanceFields(change: TextSummaryChange): string[] {
  const appearanceChange = change.appearanceChange ?? change;
  const labels = textAppearanceChangeLabels(appearanceChange);
  const hasAppearanceChange =
    change.kind === "font_changed" || Boolean(change.font) || Boolean(change.appearanceChange);

  if (!hasAppearanceChange) return [];
  return labels;
}

function formatAppearanceDetail(change: TextSummaryChange): string | undefined {
  const labels = formatAppearanceFields(change);
  return labels.length > 0 ? `  - appearance: ${labels.join(", ")}` : undefined;
}

function formatAppearanceLabelSuffix(change: TextSummaryChange): string {
  const labels = formatAppearanceFields(change);
  return labels.length > 0 ? ` (${labels.join(", ")})` : "";
}

function textAppearanceChangeLabels(change: TextChange): string[] {
  const reasonCodes = new Set([...(change.font?.reasonCodes ?? []), ...change.reasonCodes]);
  const labels: string[] = [];

  if (reasonCodes.has("text_color_delta")) {
    labels.push("color");
  }

  if (reasonCodes.has("text_contrast_delta")) {
    labels.push("contrast");
  }

  if (
    reasonCodes.has("bbox_geometry_delta") ||
    reasonCodes.has("baseline_delta") ||
    reasonCodes.has("per_word_aspect_delta")
  ) {
    labels.push("size/layout");
  }

  if (reasonCodes.has("stroke_width_delta") || reasonCodes.has("glyph_density_delta")) {
    labels.push("weight/stroke");
  }

  if (
    reasonCodes.has("ssim_delta") ||
    reasonCodes.has("hog_delta") ||
    reasonCodes.has("component_shape_delta")
  ) {
    labels.push("shape/rendering");
  }

  return labels;
}

function coordinateSpaceForSummary(imageSize: Size | undefined): CoordinateSpace {
  if (
    !imageSize ||
    !Number.isFinite(imageSize.width) ||
    !Number.isFinite(imageSize.height) ||
    imageSize.width <= 0 ||
    imageSize.height <= 0
  ) {
    return undefined;
  }
  return { imageSize };
}

function formatBounds(bounds: DiffBounds, coordinateSpace: CoordinateSpace): string {
  if (!coordinateSpace) {
    return `x=${formatInteger(bounds.x)} y=${formatInteger(bounds.y)} w=${formatInteger(bounds.width)} h=${formatInteger(bounds.height)}`;
  }
  return `x=${formatNormalizedPosition(bounds.x, coordinateSpace.imageSize.width)} y=${formatNormalizedPosition(bounds.y, coordinateSpace.imageSize.height)} w=${formatNormalizedPosition(bounds.width, coordinateSpace.imageSize.width)} h=${formatNormalizedPosition(bounds.height, coordinateSpace.imageSize.height)}`;
}

function formatDelta(
  delta: NonNullable<TextChange["delta"]>,
  coordinateSpace: CoordinateSpace
): string {
  if (!coordinateSpace) {
    return `dx=${formatSignedNumber(delta.x)} dy=${formatSignedNumber(delta.y)} dw=${formatSignedNumber(delta.width)} dh=${formatSignedNumber(delta.height)}`;
  }
  return `dx=${formatSignedNormalizedNumber(delta.x / coordinateSpace.imageSize.width)} dy=${formatSignedNormalizedNumber(delta.y / coordinateSpace.imageSize.height)} dw=${formatSignedNormalizedNumber(delta.width / coordinateSpace.imageSize.width)} dh=${formatSignedNormalizedNumber(delta.height / coordinateSpace.imageSize.height)}`;
}

function formatQuotedText(text: string | undefined): string {
  if (!text) return '"[none]"';
  const normalized = text.replace(/\s+/g, " ").trim();
  const truncated = normalized.length > 60 ? `${normalized.slice(0, 57).trimEnd()}...` : normalized;
  return `"${escapeQuotedText(truncated)}"`;
}

function escapeQuotedText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatSignedNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

function formatNormalizedPosition(value: number, divisor: number): string {
  return formatNormalizedNumber(clamp(value / divisor, 0, 1));
}

function formatNormalizedNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10_000) / 10_000;
  if (Object.is(rounded, -0)) return "0";
  return rounded.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
    useGrouping: false,
  });
}

function formatSignedNormalizedNumber(value: number): string {
  const formatted = formatNormalizedNumber(value);
  return value > 0 && formatted !== "0" ? `+${formatted}` : formatted;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatPercentage(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
    maximumFractionDigits: 2,
  })}%`;
}
