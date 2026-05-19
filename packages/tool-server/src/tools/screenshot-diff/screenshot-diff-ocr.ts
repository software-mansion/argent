import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffBounds } from "./screenshot-diff";

const execFileAsync = promisify(execFile);

const OCR_TIMEOUT_MS = 10_000;
const OCR_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MIN_SEGMENT_GAP_PX = 48;
const MAX_VERTICAL_GAP_LINE_HEIGHT_RATIO = 1.4;
const MAX_LEFT_EDGE_DELTA_LINE_HEIGHT_RATIO = 2.0;
const MIN_HORIZONTAL_OVERLAP_RATIO = 0.35;
const MAX_HEIGHT_RATIO = 1.5;
const MIN_CONTINUATION_WORDS = 2;
const MIN_CROSS_BLOCK_CONFIDENCE = 0.85;
const REQUIRED_TSV_HEADERS = [
  "level",
  "page_num",
  "block_num",
  "par_num",
  "line_num",
  "word_num",
  "left",
  "top",
  "width",
  "height",
  "conf",
  "text",
] as const;

export interface OcrWord {
  text: string;
  confidence: number;
  bounds: DiffBounds;
  blockNum: number;
  parNum: number;
  lineNum: number;
  wordNum: number;
}

export interface OcrTextBlock {
  text: string;
  confidence: number;
  bounds: DiffBounds;
  words: OcrWord[];
}

export interface OcrExtractionResult {
  status: "ok" | "unavailable";
  provider: "tesseract";
  blocks: OcrTextBlock[];
}

interface TesseractWord extends OcrWord {
  key: string;
  pageNum: number;
  segmentIndex: number;
}

interface OcrLineSegment {
  pageNum: number;
  blockNum: number;
  parNum: number;
  lineNum: number;
  segmentIndex: number;
  words: TesseractWord[];
  bounds: DiffBounds;
  confidence: number;
}

export async function extractOcrTextBlocks(imagePath: string): Promise<OcrExtractionResult> {
  try {
    const { stdout } = await execFileAsync(
      "tesseract",
      [imagePath, "stdout", "--psm", "11", "-l", "eng", "tsv"],
      {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: OCR_MAX_BUFFER_BYTES,
      }
    );
    return {
      status: "ok",
      provider: "tesseract",
      blocks: parseTesseractTsv(stdout),
    };
  } catch {
    return {
      status: "unavailable",
      provider: "tesseract",
      blocks: [],
    };
  }
}

export function parseTesseractTsv(tsv: string): OcrTextBlock[] {
  const [headerLine, ...lines] = tsv.split(/\r?\n/);
  if (!headerLine) return [];

  const headers = headerLine.replace(/^\uFEFF/u, "").split("\t");
  const indexByName = new Map(headers.map((header, index) => [header, index]));
  validateTsvHeaders(indexByName);
  const words: TesseractWord[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const values = line.split("\t");
    const level = readTsvNumber(values, indexByName, "level");
    const text = readTsvString(values, indexByName, "text").trim();
    const rawConfidence = readTsvNumber(values, indexByName, "conf");
    if (level !== 5 || rawConfidence < 0 || !isMeaningfulText(text)) continue;

    const bounds = {
      x: readTsvNumber(values, indexByName, "left"),
      y: readTsvNumber(values, indexByName, "top"),
      width: readTsvNumber(values, indexByName, "width"),
      height: readTsvNumber(values, indexByName, "height"),
    };
    if (bounds.width <= 0 || bounds.height <= 0) continue;

    const blockNum = readTsvNumber(values, indexByName, "block_num");
    const parNum = readTsvNumber(values, indexByName, "par_num");
    const lineNum = readTsvNumber(values, indexByName, "line_num");
    const wordNum = readTsvNumber(values, indexByName, "word_num");
    const pageNum = readTsvNumber(values, indexByName, "page_num");

    words.push({
      key: [pageNum, blockNum, parNum, lineNum].join(":"),
      pageNum,
      segmentIndex: 0,
      text,
      confidence: rawConfidence / 100,
      bounds,
      blockNum,
      parNum,
      lineNum,
      wordNum,
    });
  }

  const wordsByLine = new Map<string, TesseractWord[]>();
  for (const word of words) {
    const existing = wordsByLine.get(word.key);
    if (existing) existing.push(word);
    else wordsByLine.set(word.key, [word]);
  }

  const lineSegments = Array.from(wordsByLine.values()).flatMap(toLineSegments);
  return mergeVerticalLineSegments(lineSegments)
    .map(toMergedOcrTextBlock)
    .filter((block): block is OcrTextBlock => block !== null);
}

function toLineSegments(words: TesseractWord[]): OcrLineSegment[] {
  if (words.length === 0) return [];
  const first = words[0];
  return splitLineWordsIntoSegments(words).map((segmentWords, segmentIndex) => {
    const indexedWords = segmentWords.map((word) => ({ ...word, segmentIndex }));
    return {
      pageNum: first.pageNum,
      blockNum: first.blockNum,
      parNum: first.parNum,
      lineNum: first.lineNum,
      segmentIndex,
      words: indexedWords,
      bounds: unionBounds(indexedWords.map((word) => word.bounds)),
      confidence: average(indexedWords.map((word) => word.confidence)),
    };
  });
}

function mergeVerticalLineSegments(segments: OcrLineSegment[]): OcrLineSegment[][] {
  const segmentsByPage = new Map<number, OcrLineSegment[]>();

  for (const segment of segments) {
    const existing = segmentsByPage.get(segment.pageNum);
    if (existing) existing.push(segment);
    else segmentsByPage.set(segment.pageNum, [segment]);
  }

  const mergedParagraphs: OcrLineSegment[][] = [];

  for (const pageSegments of segmentsByPage.values()) {
    const sortedSegments = [...pageSegments].sort(compareSegmentsByPosition);
    const activeParagraphs: OcrLineSegment[][] = [];

    for (const segment of sortedSegments) {
      let bestParagraph: OcrLineSegment[] | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const paragraph of activeParagraphs) {
        const previous = paragraph.at(-1);
        if (!previous || !shouldMergeVertical(previous, segment, paragraph.length > 1)) continue;

        const score = mergeCandidateScore(previous, segment);
        if (score > bestScore) {
          bestParagraph = paragraph;
          bestScore = score;
        }
      }

      if (bestParagraph) bestParagraph.push(segment);
      else activeParagraphs.push([segment]);
    }

    mergedParagraphs.push(...activeParagraphs);
  }

  return mergedParagraphs.sort((left, right) =>
    compareBoundsByPosition(mergedSegmentBounds(left), mergedSegmentBounds(right))
  );
}

function splitLineWordsIntoSegments(words: TesseractWord[]): TesseractWord[][] {
  const sortedWords = [...words].sort(
    (left, right) => left.bounds.x - right.bounds.x || left.wordNum - right.wordNum
  );
  const segments: TesseractWord[][] = [];
  let currentSegment: TesseractWord[] = [];

  for (const word of sortedWords) {
    const previous = currentSegment.at(-1);
    if (!previous) {
      currentSegment.push(word);
      continue;
    }

    const gap = word.bounds.x - (previous.bounds.x + previous.bounds.width);
    const height = Math.max(previous.bounds.height, word.bounds.height);
    if (gap > Math.max(MIN_SEGMENT_GAP_PX, height * 2.5)) {
      segments.push(currentSegment);
      currentSegment = [word];
      continue;
    }
    currentSegment.push(word);
  }

  if (currentSegment.length > 0) segments.push(currentSegment);
  return segments;
}

function shouldMergeVertical(
  previous: OcrLineSegment,
  next: OcrLineSegment,
  currentParagraphHasMultipleLines: boolean
): boolean {
  if (previous.pageNum !== next.pageNum) return false;
  const sameOcrParagraph = previous.blockNum === next.blockNum && previous.parNum === next.parNum;
  if (sameOcrParagraph && next.lineNum <= previous.lineNum) return false;
  if (
    !sameOcrParagraph &&
    !canMergeAcrossOcrBlock(previous, next, currentParagraphHasMultipleLines)
  )
    return false;

  const gap = verticalGap(previous, next);
  const maxLineHeight = Math.max(previous.bounds.height, next.bounds.height);
  if (gap < 0 || gap > maxLineHeight * MAX_VERTICAL_GAP_LINE_HEIGHT_RATIO) return false;

  const minLineHeight = Math.min(previous.bounds.height, next.bounds.height);
  if (minLineHeight <= 0 || maxLineHeight / minLineHeight > MAX_HEIGHT_RATIO) return false;

  const leftEdgeDelta = Math.abs(next.bounds.x - previous.bounds.x);
  const hasCompatibleHorizontalRelationship =
    leftEdgeDelta <= maxLineHeight * MAX_LEFT_EDGE_DELTA_LINE_HEIGHT_RATIO ||
    horizontalOverlapRatio(previous.bounds, next.bounds) >= MIN_HORIZONTAL_OVERLAP_RATIO;
  if (!hasCompatibleHorizontalRelationship) return false;

  return (
    next.words.length >= MIN_CONTINUATION_WORDS ||
    currentParagraphHasMultipleLines ||
    leftEdgeDelta <= maxLineHeight
  );
}

function canMergeAcrossOcrBlock(
  previous: OcrLineSegment,
  next: OcrLineSegment,
  currentParagraphHasMultipleLines: boolean
): boolean {
  if (previous.blockNum === next.blockNum) return false;
  if (next.lineNum > previous.lineNum + 1) return false;
  if (
    previous.confidence < MIN_CROSS_BLOCK_CONFIDENCE ||
    next.confidence < MIN_CROSS_BLOCK_CONFIDENCE
  )
    return false;
  if (isAllCapsLabel(previous) || isAllCapsLabel(next)) return false;
  return (
    currentParagraphHasMultipleLines ||
    previous.words.length >= MIN_CONTINUATION_WORDS ||
    next.words.length >= MIN_CONTINUATION_WORDS
  );
}

function isAllCapsLabel(segment: OcrLineSegment): boolean {
  const text = segment.words.map((word) => word.text).join(" ");
  const letters = Array.from(text.matchAll(/\p{L}/gu), (match) => match[0]);
  if (letters.length === 0) return false;
  return letters.every((letter) => letter === letter.toLocaleUpperCase("en-US"));
}

function mergeCandidateScore(previous: OcrLineSegment, next: OcrLineSegment): number {
  const maxLineHeight = Math.max(previous.bounds.height, next.bounds.height);
  const leftEdgeDelta = Math.abs(next.bounds.x - previous.bounds.x);
  const overlap = horizontalOverlapRatio(previous.bounds, next.bounds);
  return overlap * 100 - leftEdgeDelta / Math.max(maxLineHeight, 1) - verticalGap(previous, next);
}

function verticalGap(previous: OcrLineSegment, next: OcrLineSegment): number {
  return next.bounds.y - (previous.bounds.y + previous.bounds.height);
}

function horizontalOverlapRatio(left: DiffBounds, right: DiffBounds): number {
  const intersectionLeft = Math.max(left.x, right.x);
  const intersectionRight = Math.min(left.x + left.width, right.x + right.width);
  const intersectionWidth = Math.max(0, intersectionRight - intersectionLeft);
  return intersectionWidth / Math.min(left.width, right.width);
}

function toMergedOcrTextBlock(segments: OcrLineSegment[]): OcrTextBlock | null {
  const words = [...segments]
    .sort(compareSegmentsByPosition)
    .flatMap((segment) =>
      [...segment.words].sort(
        (left, right) => left.bounds.x - right.bounds.x || left.wordNum - right.wordNum
      )
    );
  if (words.length === 0) return null;
  return {
    text: words.map((word) => word.text).join(" "),
    confidence: roundToTwo(average(words.map((word) => word.confidence))),
    bounds: unionBounds(words.map((word) => word.bounds)),
    words: words.map(
      ({ key: _key, pageNum: _pageNum, segmentIndex: _segmentIndex, ...word }) => word
    ),
  };
}

function compareSegmentsByPosition(left: OcrLineSegment, right: OcrLineSegment): number {
  return (
    left.bounds.y - right.bounds.y ||
    left.bounds.x - right.bounds.x ||
    left.lineNum - right.lineNum ||
    left.segmentIndex - right.segmentIndex
  );
}

function compareBoundsByPosition(left: DiffBounds, right: DiffBounds): number {
  return left.y - right.y || left.x - right.x;
}

function mergedSegmentBounds(segments: OcrLineSegment[]): DiffBounds {
  return unionBounds(segments.map((segment) => segment.bounds));
}

function unionBounds(bounds: DiffBounds[]): DiffBounds {
  if (bounds.length === 0) throw new Error("Cannot union empty OCR bounds.");

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const rect of bounds) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function validateTsvHeaders(indexByName: Map<string, number>): void {
  const missingHeaders = REQUIRED_TSV_HEADERS.filter((header) => !indexByName.has(header));
  if (missingHeaders.length > 0) {
    throw new Error(
      `Invalid Tesseract TSV: missing required column(s): ${missingHeaders.join(", ")}`
    );
  }
}

function readTsvString(values: string[], indexByName: Map<string, number>, name: string): string {
  const index = indexByName.get(name);
  return index === undefined ? "" : (values[index] ?? "");
}

function readTsvNumber(values: string[], indexByName: Map<string, number>, name: string): number {
  const value = Number(readTsvString(values, indexByName, name));
  return Number.isFinite(value) ? value : 0;
}

function isMeaningfulText(text: string): boolean {
  if (/[\p{L}\p{N}]/u.test(text)) return true;
  return /[\p{Sc}\p{Sm}\p{Pd}%‰‱#@/\\✓✔✕✖]/u.test(text);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}
