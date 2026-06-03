import type { DiffBounds } from "./screenshot-diff";
import { extractOcrTextBlocks } from "./screenshot-diff-ocr";
import {
  detectFontGeometryChange,
  type FontGeometryEvidence,
  type FontGeometryImage,
  type FontGeometryReasonCode,
} from "./font-diff";

export type TextChangeKind =
  | "moved"
  | "appeared"
  | "disappeared"
  | "content_changed"
  | "font_changed";
export type TextChangeSource = "ocr";
export type TextAnalysisProvider = "ocr";
export type TextReasonCode =
  | "exact_normalized_match"
  | "ocr_noise_tolerated"
  | "position_delta"
  | "missing_in_current"
  | "missing_in_baseline"
  | "same_location"
  | "text_similarity"
  | "normalized_text_changed"
  | FontGeometryReasonCode;

export interface TextRegionWord {
  text: string;
  confidence: number;
  bounds: DiffBounds;
}

export interface TextRegion {
  text: string;
  bounds: DiffBounds;
  confidence?: number;
  words?: TextRegionWord[];
}

export interface TextChange {
  kind: TextChangeKind;
  text?: string;
  baselineText?: string;
  currentText?: string;
  normalizedText?: string;
  baselineBounds?: DiffBounds;
  currentBounds?: DiffBounds;
  delta?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  font?: FontGeometryEvidence;
  confidence: number;
  source: TextChangeSource;
  reasonCodes: TextReasonCode[];
}

export interface TextAnalysis {
  status: "ok" | "unavailable" | "skipped";
  provider: TextAnalysisProvider;
  changes: TextChange[];
}

export interface AnalyzeScreenshotTextOptions {
  baselinePath: string;
  currentPath: string;
  hasPixelDiff?: boolean;
  baselineImage?: FontGeometryImage;
  currentImage?: FontGeometryImage;
  ignoreTopPixels?: number;
  textChangeMinConfidence?: number;
}

interface NormalizedTextRegion extends TextRegion {
  normalizedText: string;
  matchKey: string;
  confidence: number;
}

interface PairCandidate {
  baselineIndex: number;
  currentIndex: number;
  score: number;
  exact: boolean;
}

interface ContentCandidate {
  baselineIndex: number;
  currentIndex: number;
  score: number;
  reasonCodes: TextReasonCode[];
}

const MOVE_THRESHOLD_PX = 3;
const LOCATION_OVERLAP_THRESHOLD = 0.45;
const LOCATION_CENTER_DISTANCE_PX = 18;
const FUZZY_SAME_TEXT_CENTER_DISTANCE_PX = 60;
const MAX_TEXT_CHANGES = 10;
export const DEFAULT_TEXT_CHANGE_MIN_CONFIDENCE = 0.7;

export async function analyzeScreenshotTextChanges(
  options: AnalyzeScreenshotTextOptions
): Promise<TextAnalysis> {
  if (options.hasPixelDiff === false) {
    return {
      status: "skipped",
      provider: "ocr",
      changes: [],
    };
  }

  const [baselineOcr, currentOcr] = await Promise.all([
    extractOcrTextBlocks(options.baselinePath),
    extractOcrTextBlocks(options.currentPath),
  ]);
  if (baselineOcr.status !== "ok" || currentOcr.status !== "ok") {
    return {
      status: "unavailable",
      provider: "ocr",
      changes: [],
    };
  }

  return analyzeTextRegions({
    baselineRegions: baselineOcr.blocks,
    currentRegions: currentOcr.blocks,
    baselineImage: options.baselineImage,
    currentImage: options.currentImage,
    ignoreTopPixels: options.ignoreTopPixels,
    textChangeMinConfidence: options.textChangeMinConfidence,
  });
}

export function analyzeTextRegions(params: {
  baselineRegions: TextRegion[];
  currentRegions: TextRegion[];
  baselineImage?: FontGeometryImage;
  currentImage?: FontGeometryImage;
  ignoreTopPixels?: number;
  textChangeMinConfidence?: number;
}): TextAnalysis {
  const textChangeMinConfidence =
    params.textChangeMinConfidence ?? DEFAULT_TEXT_CHANGE_MIN_CONFIDENCE;
  validateTextChangeMinConfidence(textChangeMinConfidence);

  const baseline = normalizeRegions(
    filterRegionsByTopCutoff(params.baselineRegions, params.ignoreTopPixels)
  );
  const current = normalizeRegions(
    filterRegionsByTopCutoff(params.currentRegions, params.ignoreTopPixels)
  );
  const usedBaseline = new Set<number>();
  const usedCurrent = new Set<number>();
  const changes: TextChange[] = [];

  for (const pair of pairSameTextRegions(baseline, current)) {
    if (usedBaseline.has(pair.baselineIndex) || usedCurrent.has(pair.currentIndex)) continue;
    usedBaseline.add(pair.baselineIndex);
    usedCurrent.add(pair.currentIndex);

    const baselineRegion = baseline[pair.baselineIndex];
    const currentRegion = current[pair.currentIndex];
    const delta = boundsDelta(baselineRegion.bounds, currentRegion.bounds);

    if (isMeaningfulMove(delta)) {
      changes.push({
        kind: "moved",
        text: baselineRegion.text,
        normalizedText: baselineRegion.normalizedText,
        baselineBounds: baselineRegion.bounds,
        currentBounds: currentRegion.bounds,
        delta,
        confidence: clampConfidence(
          Math.min(baselineRegion.confidence, currentRegion.confidence) * (pair.exact ? 0.96 : 0.78)
        ),
        source: "ocr",
        reasonCodes: [
          pair.exact ? "exact_normalized_match" : "ocr_noise_tolerated",
          "position_delta",
        ],
      });
    }

    if (params.baselineImage && params.currentImage) {
      const font = detectFontGeometryChange({
        baselineImage: params.baselineImage,
        currentImage: params.currentImage,
        baselineRegion,
        currentRegion,
      });
      if (font) {
        changes.push({
          kind: "font_changed",
          text: baselineRegion.text,
          normalizedText: baselineRegion.normalizedText,
          baselineBounds: baselineRegion.bounds,
          currentBounds: currentRegion.bounds,
          delta,
          font,
          confidence: font.confidence,
          source: "ocr",
          reasonCodes: [
            pair.exact ? "exact_normalized_match" : "ocr_noise_tolerated",
            ...font.reasonCodes,
          ],
        });
      }
    }
  }

  for (const pair of pairChangedTextRegions(baseline, current, usedBaseline, usedCurrent)) {
    if (usedBaseline.has(pair.baselineIndex) || usedCurrent.has(pair.currentIndex)) continue;
    usedBaseline.add(pair.baselineIndex);
    usedCurrent.add(pair.currentIndex);
    const baselineRegion = baseline[pair.baselineIndex];
    const currentRegion = current[pair.currentIndex];
    changes.push({
      kind: "content_changed",
      baselineText: baselineRegion.text,
      currentText: currentRegion.text,
      baselineBounds: baselineRegion.bounds,
      currentBounds: currentRegion.bounds,
      delta: boundsDelta(baselineRegion.bounds, currentRegion.bounds),
      confidence: clampConfidence(
        Math.min(baselineRegion.confidence, currentRegion.confidence) * pair.score
      ),
      source: "ocr",
      reasonCodes: pair.reasonCodes,
    });
  }

  for (let index = 0; index < baseline.length; index++) {
    if (usedBaseline.has(index)) continue;
    const region = baseline[index];
    changes.push({
      kind: "disappeared",
      text: region.text,
      normalizedText: region.normalizedText,
      baselineBounds: region.bounds,
      confidence: clampConfidence(region.confidence * 0.78),
      source: "ocr",
      reasonCodes: ["missing_in_current"],
    });
  }

  for (let index = 0; index < current.length; index++) {
    if (usedCurrent.has(index)) continue;
    const region = current[index];
    changes.push({
      kind: "appeared",
      text: region.text,
      normalizedText: region.normalizedText,
      currentBounds: region.bounds,
      confidence: clampConfidence(region.confidence * 0.78),
      source: "ocr",
      reasonCodes: ["missing_in_baseline"],
    });
  }

  const filteredChanges = changes
    .filter((change) => change.confidence >= textChangeMinConfidence)
    .sort(
      (left, right) => changeTop(left) - changeTop(right) || changeLeft(left) - changeLeft(right)
    );
  return {
    status: "ok",
    provider: "ocr",
    changes: retainPrimaryChangesWithAuxiliaryFontEvidence(filteredChanges, MAX_TEXT_CHANGES),
  };
}

export function normalizeTextForDiff(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ");

  return restoreValueSymbols(
    protectValueSymbols(normalized)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const VALUE_SYMBOL_TOKENS: Record<string, string> = {
  "%": "ARGENTPERCENTTOKEN",
  "$": "ARGENTDOLLARTOKEN",
  "\u20ac": "ARGENTEUROTOKEN",
  "\u00a3": "ARGENTPOUNDTOKEN",
  "\u00a5": "ARGENTYENTOKEN",
  "\u20b9": "ARGENTRUPEETOKEN",
  "\u20a9": "ARGENTWONTOKEN",
  "\u20bd": "ARGENTRUBLETOKEN",
  "\u00a2": "ARGENTCENTTOKEN",
  "+": "ARGENTPLUSTOKEN",
  "-": "ARGENTMINUSTOKEN",
  "/": "ARGENTSLASHTOKEN",
};

const VALUE_SYMBOL_RESTORES = Object.entries(VALUE_SYMBOL_TOKENS).map(([symbol, token]) => ({
  symbol,
  token: new RegExp(token, "g"),
}));

function protectValueSymbols(text: string): string {
  const currencyBeforeNumber =
    /([$\u20ac\u00a3\u00a5\u20b9\u20a9\u20bd\u00a2])\s*([+-]?)\s*(\p{N})/gu;
  const currencyAfterNumber = /(\p{N})\s*([$\u20ac\u00a3\u00a5\u20b9\u20a9\u20bd\u00a2])/gu;
  return text
    .replace(/(\p{N})\s*%/gu, `$1${VALUE_SYMBOL_TOKENS["%"]}`)
    .replace(currencyBeforeNumber, (match, currency: string, sign: string, digit: string) => {
      return `${VALUE_SYMBOL_TOKENS[currency] ?? currency}${
        sign ? (VALUE_SYMBOL_TOKENS[sign] ?? sign) : ""
      }${digit}`;
    })
    .replace(currencyAfterNumber, (match, digit: string, currency: string) => {
      return `${digit}${VALUE_SYMBOL_TOKENS[currency] ?? currency}`;
    })
    .replace(
      /(^|[^\p{L}\p{N}])([+-])\s*(\p{N})/gu,
      (match, prefix: string, symbol: string, digit: string) => {
        return `${prefix}${VALUE_SYMBOL_TOKENS[symbol] ?? symbol}${digit}`;
      }
    )
    .replace(/(\p{N})([+-])(\p{N})/gu, (match, left: string, symbol: string, right: string) => {
      return `${left}${VALUE_SYMBOL_TOKENS[symbol] ?? symbol}${right}`;
    })
    .replace(/([\p{L}\p{N}])\s*\/\s*([\p{L}\p{N}])/gu, `$1${VALUE_SYMBOL_TOKENS["/"]}$2`);
}

function restoreValueSymbols(text: string): string {
  let restored = text;
  for (const { symbol, token } of VALUE_SYMBOL_RESTORES) {
    restored = restored.replace(token, symbol);
  }
  return restored;
}

function normalizeRegions(regions: TextRegion[]): NormalizedTextRegion[] {
  return regions
    .map((region) => {
      const normalizedText = normalizeTextForDiff(region.text);
      return {
        ...region,
        confidence: clampConfidence(region.confidence ?? 1),
        normalizedText,
        matchKey: ocrNoiseKey(normalizedText),
      };
    })
    .filter((region) => region.normalizedText.length > 0);
}

function filterRegionsByTopCutoff(regions: TextRegion[], ignoreTopPixels = 0): TextRegion[] {
  if (ignoreTopPixels <= 0) return regions;
  return regions.filter((region) => region.bounds.y + region.bounds.height > ignoreTopPixels);
}

function validateTextChangeMinConfidence(minConfidence: number): void {
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error(
      `textChangeMinConfidence must be a finite number between 0 and 1, received ${minConfidence}`
    );
  }
}

function pairSameTextRegions(
  baseline: NormalizedTextRegion[],
  current: NormalizedTextRegion[]
): PairCandidate[] {
  const candidates: PairCandidate[] = [];
  for (let baselineIndex = 0; baselineIndex < baseline.length; baselineIndex++) {
    for (let currentIndex = 0; currentIndex < current.length; currentIndex++) {
      const left = baseline[baselineIndex];
      const right = current[currentIndex];
      const exact = left.normalizedText === right.normalizedText;
      const similarity = normalizedTextSimilarity(left.matchKey, right.matchKey);
      const distance = centerDistance(left.bounds, right.bounds);
      const fuzzy =
        !exact &&
        valueTokensCompatible(left.normalizedText, right.normalizedText) &&
        distance <= FUZZY_SAME_TEXT_CENTER_DISTANCE_PX &&
        similarity >= fuzzyThreshold(left.matchKey, right.matchKey);
      if (!exact && !fuzzy) continue;

      candidates.push({
        baselineIndex,
        currentIndex,
        exact,
        score: (exact ? 100 : 70 + similarity * 10) - Math.min(25, distance / 8),
      });
    }
  }

  return candidates.sort((left, right) => right.score - left.score);
}

function pairChangedTextRegions(
  baseline: NormalizedTextRegion[],
  current: NormalizedTextRegion[],
  usedBaseline: Set<number>,
  usedCurrent: Set<number>
): ContentCandidate[] {
  const candidates: ContentCandidate[] = [];

  for (let baselineIndex = 0; baselineIndex < baseline.length; baselineIndex++) {
    if (usedBaseline.has(baselineIndex)) continue;
    for (let currentIndex = 0; currentIndex < current.length; currentIndex++) {
      if (usedCurrent.has(currentIndex)) continue;
      const left = baseline[baselineIndex];
      const right = current[currentIndex];
      if (left.normalizedText === right.normalizedText) continue;

      const reasonCodes: TextReasonCode[] = ["normalized_text_changed"];
      let score = 0;
      const overlap = intersectionOverUnion(left.bounds, right.bounds);
      const distance = centerDistance(left.bounds, right.bounds);
      if (overlap >= LOCATION_OVERLAP_THRESHOLD) {
        score = 0.84 + overlap * 0.1;
        reasonCodes.push("same_location");
      } else if (distance <= LOCATION_CENTER_DISTANCE_PX) {
        score = 0.74;
        reasonCodes.push("same_location");
      }

      const similarity = normalizedTextSimilarity(left.matchKey, right.matchKey);
      if (score === 0 && similarity >= 0.65 && distance <= 60) {
        score = 0.64 + similarity * 0.1;
        reasonCodes.push("text_similarity");
      }
      if (score === 0) continue;

      candidates.push({ baselineIndex, currentIndex, score, reasonCodes });
    }
  }

  return candidates.sort((left, right) => right.score - left.score);
}

function ocrNoiseKey(text: string): string {
  return text
    .replace(/[0]/g, "o")
    .replace(/[1|]/g, "l")
    .replace(/[3]/g, "e")
    .replace(/[5]/g, "s")
    .replace(/[8]/g, "b")
    .replace(/\brn/g, "m");
}

function fuzzyThreshold(left: string, right: string): number {
  const length = Math.max(left.length, right.length);
  if (length <= 4) return Number.POSITIVE_INFINITY;
  if (length <= 8) return 0.86;
  return 0.82;
}

function valueTokensCompatible(left: string, right: string): boolean {
  const leftTokens = valueTokens(left);
  const rightTokens = valueTokens(right);
  if (leftTokens.length === 0 && rightTokens.length === 0) return true;
  return (
    leftTokens.length === rightTokens.length &&
    leftTokens.every((token, index) => token === rightTokens[index])
  );
}

function valueTokens(text: string): string[] {
  return text.match(/(?<!\p{L})(?:[$€£¥₹₩₽¢+\-/])?\p{N}+(?:[.,]\p{N}+)?%?(?!\p{L})/gu) ?? [];
}

function normalizedTextSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  return 1 - levenshteinDistance(left, right) / maxLength;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);
  for (let index = 0; index <= right.length; index++) previous[index] = index;

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost
      );
    }
    for (let index = 0; index <= right.length; index++) previous[index] = current[index];
  }

  return previous[right.length];
}

function boundsDelta(baseline: DiffBounds, current: DiffBounds): NonNullable<TextChange["delta"]> {
  return {
    x: current.x - baseline.x,
    y: current.y - baseline.y,
    width: current.width - baseline.width,
    height: current.height - baseline.height,
  };
}

function isMeaningfulMove(delta: NonNullable<TextChange["delta"]>): boolean {
  return Math.abs(delta.x) >= MOVE_THRESHOLD_PX || Math.abs(delta.y) >= MOVE_THRESHOLD_PX;
}

function intersectionOverUnion(left: DiffBounds, right: DiffBounds): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (intersection === 0) return 0;
  const leftArea = left.width * left.height;
  const rightArea = right.width * right.height;
  return intersection / (leftArea + rightArea - intersection);
}

function centerDistance(left: DiffBounds, right: DiffBounds): number {
  const leftCenter = { x: left.x + left.width / 2, y: left.y + left.height / 2 };
  const rightCenter = { x: right.x + right.width / 2, y: right.y + right.height / 2 };
  return Math.sqrt((leftCenter.x - rightCenter.x) ** 2 + (leftCenter.y - rightCenter.y) ** 2);
}

function changeTop(change: TextChange): number {
  return (change.baselineBounds ?? change.currentBounds)?.y ?? 0;
}

function changeLeft(change: TextChange): number {
  return (change.baselineBounds ?? change.currentBounds)?.x ?? 0;
}

function retainPrimaryChangesWithAuxiliaryFontEvidence(
  changes: TextChange[],
  maxPrimaryChanges: number
): TextChange[] {
  const retained: TextChange[] = [];
  let retainedPrimaryCount = 0;

  for (const change of changes) {
    if (!isAuxiliaryPairedFontChange(change, changes)) {
      if (retainedPrimaryCount >= maxPrimaryChanges) continue;
      retainedPrimaryCount++;
      retained.push(change);
      continue;
    }

    if (
      retained.some(
        (candidate) => candidate.kind === "moved" && isSameTextLocationChange(candidate, change)
      )
    ) {
      retained.push(change);
    }
  }

  return retained;
}

function isAuxiliaryPairedFontChange(change: TextChange, changes: TextChange[]): boolean {
  return (
    change.kind === "font_changed" &&
    changes.some(
      (candidate) => candidate.kind === "moved" && isSameTextLocationChange(candidate, change)
    )
  );
}

function isSameTextLocationChange(left: TextChange, right: TextChange): boolean {
  const leftText = left.normalizedText ?? normalizeComparisonText(left.text);
  const rightText = right.normalizedText ?? normalizeComparisonText(right.text);
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

function normalizeComparisonText(text: string | undefined): string {
  return text?.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US") ?? "";
}

function clampConfidence(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}
