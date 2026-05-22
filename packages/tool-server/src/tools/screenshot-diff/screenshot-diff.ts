import fs from "fs/promises";
import path from "path";
import { PNG } from "pngjs";
import {
  analyzeScreenshotTextChanges,
  DEFAULT_TEXT_CHANGE_MIN_CONFIDENCE,
  type TextAnalysis,
} from "./text-diff";
import { formatScreenshotDiffSummary } from "./screenshot-diff-summary";

export interface Size {
  width: number;
  height: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface DiffBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DominantColorChange {
  channel: "red" | "green" | "blue" | "luminance" | "none";
  direction: "increase" | "decrease" | "none";
  magnitude: number;
}

export interface DiffRegion {
  bounds: DiffBounds;
  pixelCount: number;
  averageColor: {
    delta: Rgb;
    dominantChange: DominantColorChange;
  };
}

export interface PngDiffResult {
  totalPixels: number;
  differentPixels: number;
  mismatchPercentage: number;
  imageSize?: Size;
  summary: string;
  diffPath?: string;
  contextDiffPath?: string;
  dimensionMismatch?: {
    expected: Size;
    actual: Size;
  };
  regions: DiffRegion[];
  textAnalysis?: TextAnalysis;
}

interface DecodedPng {
  width: number;
  height: number;
  data: Buffer;
}

interface ChangeRegion {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  pixelCount: number;
  baselineSum: Rgb;
  currentSum: Rgb;
}

interface DiffSettings {
  thresholdSquared: number;
  ignoreTopNormalizedY: number;
  joinGapPixels: number;
  contextDiffScale: number;
}

interface DiffMask {
  mask: Uint8Array;
  differentPixels: number;
  ignoredTopRows: number;
}

interface DiffArtifactPaths {
  diffPath: string;
  contextDiffPath: string;
}

const MAX_RGB_DISTANCE_SQUARED = 255 * 255 * 3;
const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_IGNORE_TOP_NORMALIZED_Y = 0.06;
const DEFAULT_REGION_MERGE_DISTANCE = 8;
const DEFAULT_CONTEXT_DIFF_SCALE = 0.3;
const REGION_RECTANGLE_STROKE_WIDTH = 4;
const REGION_RECTANGLE_COLOR: Rgb = { r: 255, g: 220, b: 0 };
const DIFF_BRIGHTER_COLOR: Rgb = { r: 0, g: 200, b: 0 };
const DIFF_DARKER_COLOR: Rgb = { r: 255, g: 0, b: 0 };
const HORIZONTAL_TEXT_MERGE_HEIGHT_MULTIPLIER = 3;
const HORIZONTAL_TEXT_MERGE_MIN_GAP = 32;
const HORIZONTAL_TEXT_MERGE_MAX_GAP = 120;
// Treat only near-equal RGB movement as luminance so color-tinted changes
// still report the dominant RGB channel.
const UNIFORM_BRIGHTNESS_DELTA_TOLERANCE = 4;

export async function diffPngFiles(options: {
  baselinePath: string;
  currentPath: string;
  outputDir: string;
}): Promise<PngDiffResult> {
  const settings = resolveDiffSettings();

  const [baseline, current] = await Promise.all([
    decodePngFile(options.baselinePath),
    decodePngFile(options.currentPath),
  ]);

  if (baseline.width !== current.width || baseline.height !== current.height) {
    return summarizeResult(
      buildDimensionMismatchResult({
        baseline,
        current,
      })
    );
  }

  const totalPixels = baseline.width * baseline.height;
  const pixelDiff = markChangedPixels({
    baseline,
    current,
    thresholdSquared: settings.thresholdSquared,
    ignoreTopNormalizedY: settings.ignoreTopNormalizedY,
  });
  const regions = getChangedRegions({
    mask: pixelDiff.mask,
    baseline,
    current,
    joinGapPixels: settings.joinGapPixels,
  });

  const artifactPaths = resolveDiffArtifactPaths(options);
  await writeDiffArtifacts({
    baseline,
    current,
    mask: pixelDiff.mask,
    regions,
    paths: artifactPaths,
    contextDiffScale: settings.contextDiffScale,
  });

  const mismatchPercentage =
    totalPixels === 0 ? 0 : (pixelDiff.differentPixels / totalPixels) * 100;

  const textAnalysis = await analyzeScreenshotTextChangesSafely({
    baselinePath: options.baselinePath,
    currentPath: options.currentPath,
    hasPixelDiff: pixelDiff.differentPixels > 0,
    baselineImage: baseline,
    currentImage: current,
    ignoreTopPixels: pixelDiff.ignoredTopRows,
    textChangeMinConfidence: DEFAULT_TEXT_CHANGE_MIN_CONFIDENCE,
  });

  return summarizeResult({
    totalPixels,
    differentPixels: pixelDiff.differentPixels,
    mismatchPercentage,
    imageSize: { width: baseline.width, height: baseline.height },
    diffPath: artifactPaths.diffPath,
    contextDiffPath: artifactPaths.contextDiffPath,
    regions,
    textAnalysis,
  });
}

function resolveDiffSettings(): DiffSettings {
  return {
    thresholdSquared: DEFAULT_THRESHOLD * DEFAULT_THRESHOLD * MAX_RGB_DISTANCE_SQUARED,
    ignoreTopNormalizedY: DEFAULT_IGNORE_TOP_NORMALIZED_Y,
    joinGapPixels: DEFAULT_REGION_MERGE_DISTANCE,
    contextDiffScale: DEFAULT_CONTEXT_DIFF_SCALE,
  };
}

function summarizeResult(result: Omit<PngDiffResult, "summary">): PngDiffResult {
  return { ...result, summary: formatScreenshotDiffSummary(result) };
}

function buildDimensionMismatchResult(params: {
  baseline: DecodedPng;
  current: DecodedPng;
}): Omit<PngDiffResult, "summary"> {
  return {
    totalPixels: params.baseline.width * params.baseline.height,
    differentPixels: 0,
    mismatchPercentage: 0,
    dimensionMismatch: {
      expected: { width: params.baseline.width, height: params.baseline.height },
      actual: { width: params.current.width, height: params.current.height },
    },
    regions: [],
    textAnalysis: {
      status: "skipped" as const,
      provider: "ocr" as const,
      changes: [],
    },
  };
}

function markChangedPixels(params: {
  baseline: DecodedPng;
  current: DecodedPng;
  thresholdSquared: number;
  ignoreTopNormalizedY: number;
}): DiffMask {
  const totalPixels = params.baseline.width * params.baseline.height;
  const baselineData = params.baseline.data;
  const currentData = params.current.data;
  const mask = new Uint8Array(totalPixels);
  const ignoredTopRows = Math.min(
    params.baseline.height,
    Math.ceil(params.baseline.height * params.ignoreTopNormalizedY)
  );
  let differentPixels = 0;

  for (let y = ignoredTopRows; y < params.baseline.height; y++) {
    for (let x = 0; x < params.baseline.width; x++) {
      const pixelIndex = y * params.baseline.width + x;
      const offset = pixelIndex * 4;
      const dr = currentData[offset] - baselineData[offset];
      const dg = currentData[offset + 1] - baselineData[offset + 1];
      const db = currentData[offset + 2] - baselineData[offset + 2];
      const rgbDistanceSquared = dr * dr + dg * dg + db * db;
      if (rgbDistanceSquared > params.thresholdSquared) {
        mask[pixelIndex] = 1;
        differentPixels++;
      }
    }
  }

  return { mask, differentPixels, ignoredTopRows };
}

function getChangedRegions(params: {
  mask: Uint8Array;
  baseline: DecodedPng;
  current: DecodedPng;
  joinGapPixels: number;
}): DiffRegion[] {
  const regions = traceChangeRegions({
    mask: params.mask,
    width: params.baseline.width,
    height: params.baseline.height,
    baselineData: params.baseline.data,
    currentData: params.current.data,
  });
  return joinChangeRegions(regions, params.joinGapPixels)
    .map(toDiffRegion)
    .sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}

function resolveDiffArtifactPaths(options: {
  currentPath: string;
  outputDir: string;
}): DiffArtifactPaths {
  const currentName = outputArtifactBaseName(options.currentPath);
  return {
    diffPath: path.join(options.outputDir, `${currentName}-diff.png`),
    contextDiffPath: path.join(options.outputDir, `${currentName}-context-diff.png`),
  };
}

function outputArtifactBaseName(filePath: string): string {
  const parsed = path.parse(path.basename(filePath));
  return parsed.name || parsed.base;
}

async function writeDiffArtifacts(params: {
  baseline: DecodedPng;
  current: DecodedPng;
  mask: Uint8Array;
  regions: DiffRegion[];
  paths: DiffArtifactPaths;
  contextDiffScale: number;
}): Promise<void> {
  const diffImage = buildContextDiff({
    baseline: params.baseline,
    current: params.current,
    mask: params.mask,
  });
  drawRegionRectangles(diffImage, params.regions);
  await writePngFile(params.paths.diffPath, diffImage);
  await writePngFile(
    params.paths.contextDiffPath,
    downscalePng(diffImage, params.contextDiffScale)
  );
}

async function decodePngFile(filePath: string): Promise<DecodedPng> {
  const buffer = await fs.readFile(filePath);
  const png = PNG.sync.read(buffer);
  return {
    width: png.width,
    height: png.height,
    data: png.data,
  };
}

async function analyzeScreenshotTextChangesSafely(
  options: Parameters<typeof analyzeScreenshotTextChanges>[0]
): Promise<TextAnalysis> {
  try {
    return await analyzeScreenshotTextChanges(options);
  } catch {
    return {
      status: "unavailable",
      provider: "ocr",
      changes: [],
    };
  }
}

function buildContextDiff(params: {
  baseline: DecodedPng;
  current: DecodedPng;
  mask: Uint8Array;
}): PNG {
  const output = new PNG({ width: params.current.width, height: params.current.height });

  for (let pixelIndex = 0; pixelIndex < params.mask.length; pixelIndex++) {
    const offset = pixelIndex * 4;
    if (params.mask[pixelIndex]) {
      const baselineLuminance = luminanceFromOffset(params.baseline.data, offset);
      const currentLuminance = luminanceFromOffset(params.current.data, offset);
      const color =
        currentLuminance >= baselineLuminance ? DIFF_BRIGHTER_COLOR : DIFF_DARKER_COLOR;
      output.data[offset] = color.r;
      output.data[offset + 1] = color.g;
      output.data[offset + 2] = color.b;
      output.data[offset + 3] = 255;
      continue;
    }

    output.data[offset] = lighten(params.current.data[offset]);
    output.data[offset + 1] = lighten(params.current.data[offset + 1]);
    output.data[offset + 2] = lighten(params.current.data[offset + 2]);
    output.data[offset + 3] = 255;
  }

  return output;
}

function luminanceFromOffset(data: Buffer, offset: number): number {
  return 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
}

async function writePngFile(filePath: string, png: PNG): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, PNG.sync.write(png));
}

function downscalePng(source: PNG, scale: number): PNG {
  const targetWidth = Math.max(1, Math.round(source.width * scale));
  const targetHeight = Math.max(1, Math.round(source.height * scale));
  if (targetWidth === source.width && targetHeight === source.height) {
    return clonePng(source);
  }

  return lanczos3ResizeRgba({
    sourceData: source.data,
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetWidth,
    targetHeight,
  });
}

interface ResampleAxisWeights {
  start: number;
  weights: Float32Array;
}

function lanczos3ResizeRgba(params: {
  sourceData: Buffer;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}): PNG {
  const horizontal = buildLanczos3AxisWeights(params.sourceWidth, params.targetWidth);
  const vertical = buildLanczos3AxisWeights(params.sourceHeight, params.targetHeight);

  const intermediate = new Float32Array(params.targetWidth * params.sourceHeight * 4);
  resampleHorizontalRgba({
    sourceData: params.sourceData,
    sourceWidth: params.sourceWidth,
    sourceHeight: params.sourceHeight,
    targetWidth: params.targetWidth,
    weights: horizontal,
    output: intermediate,
  });

  const target = new PNG({ width: params.targetWidth, height: params.targetHeight });
  resampleVerticalRgba({
    intermediate,
    targetWidth: params.targetWidth,
    targetHeight: params.targetHeight,
    weights: vertical,
    output: target.data,
  });

  return target;
}

function resampleHorizontalRgba(params: {
  sourceData: Buffer;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  weights: ResampleAxisWeights[];
  output: Float32Array;
}): void {
  for (let y = 0; y < params.sourceHeight; y++) {
    const rowOffset = y * params.sourceWidth * 4;
    const targetRowOffset = y * params.targetWidth * 4;
    for (let x = 0; x < params.targetWidth; x++) {
      const { start, weights } = params.weights[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const baseOffset = rowOffset + start * 4;
      for (let k = 0; k < weights.length; k++) {
        const sampleOffset = baseOffset + k * 4;
        const w = weights[k];
        r += params.sourceData[sampleOffset] * w;
        g += params.sourceData[sampleOffset + 1] * w;
        b += params.sourceData[sampleOffset + 2] * w;
        a += params.sourceData[sampleOffset + 3] * w;
      }
      const targetOffset = targetRowOffset + x * 4;
      params.output[targetOffset] = r;
      params.output[targetOffset + 1] = g;
      params.output[targetOffset + 2] = b;
      params.output[targetOffset + 3] = a;
    }
  }
}

function resampleVerticalRgba(params: {
  intermediate: Float32Array;
  targetWidth: number;
  targetHeight: number;
  weights: ResampleAxisWeights[];
  output: Buffer;
}): void {
  const rowStride = params.targetWidth * 4;
  for (let y = 0; y < params.targetHeight; y++) {
    const { start, weights } = params.weights[y];
    const targetRowOffset = y * rowStride;
    for (let x = 0; x < params.targetWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const columnOffset = start * rowStride + x * 4;
      for (let k = 0; k < weights.length; k++) {
        const sampleOffset = columnOffset + k * rowStride;
        const w = weights[k];
        r += params.intermediate[sampleOffset] * w;
        g += params.intermediate[sampleOffset + 1] * w;
        b += params.intermediate[sampleOffset + 2] * w;
        a += params.intermediate[sampleOffset + 3] * w;
      }
      const targetOffset = targetRowOffset + x * 4;
      params.output[targetOffset] = clampToByte(r);
      params.output[targetOffset + 1] = clampToByte(g);
      params.output[targetOffset + 2] = clampToByte(b);
      params.output[targetOffset + 3] = clampToByte(a);
    }
  }
}

function buildLanczos3AxisWeights(sourceSize: number, targetSize: number): ResampleAxisWeights[] {
  const scale = targetSize / sourceSize;
  // For downscaling, stretch the kernel by `scale` to act as a low-pass
  // anti-aliasing filter. For upscaling, evaluate the kernel at its native
  // width so we interpolate rather than blur.
  const filterScale = scale < 1 ? scale : 1;
  const supportInSource = LANCZOS3_RADIUS / filterScale;
  const axis: ResampleAxisWeights[] = new Array(targetSize);

  for (let i = 0; i < targetSize; i++) {
    const center = (i + 0.5) / scale - 0.5;
    const start = Math.max(0, Math.ceil(center - supportInSource - LANCZOS3_EPSILON));
    const end = Math.min(sourceSize - 1, Math.floor(center + supportInSource + LANCZOS3_EPSILON));
    const length = Math.max(1, end - start + 1);
    const weights = new Float32Array(length);
    let sum = 0;
    for (let k = 0; k < length; k++) {
      const sampleIndex = start + k;
      const w = lanczos3Kernel((sampleIndex - center) * filterScale);
      weights[k] = w;
      sum += w;
    }
    if (sum !== 0) {
      const inverseSum = 1 / sum;
      for (let k = 0; k < length; k++) {
        weights[k] *= inverseSum;
      }
    }
    axis[i] = { start, weights };
  }
  return axis;
}

const LANCZOS3_RADIUS = 3;
const LANCZOS3_EPSILON = 1e-9;

function lanczos3Kernel(x: number): number {
  if (x === 0) return 1;
  if (x <= -LANCZOS3_RADIUS || x >= LANCZOS3_RADIUS) return 0;
  const piX = Math.PI * x;
  return (LANCZOS3_RADIUS * Math.sin(piX) * Math.sin(piX / LANCZOS3_RADIUS)) / (piX * piX);
}

function clampToByte(value: number): number {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

function clonePng(source: PNG): PNG {
  const target = new PNG({ width: source.width, height: source.height });
  source.data.copy(target.data);
  return target;
}

function drawRegionRectangles(png: PNG, regions: DiffRegion[]): void {
  for (const region of regions) {
    drawRectangle(png, region.bounds, REGION_RECTANGLE_STROKE_WIDTH, REGION_RECTANGLE_COLOR);
  }
}

function drawRectangle(png: PNG, bounds: DiffBounds, strokeWidth: number, color: Rgb): void {
  const minX = Math.max(0, bounds.x);
  const minY = Math.max(0, bounds.y);
  const maxX = Math.min(png.width - 1, bounds.x + bounds.width - 1);
  const maxY = Math.min(png.height - 1, bounds.y + bounds.height - 1);
  if (minX > maxX || minY > maxY) return;

  for (let strokeOffset = 0; strokeOffset < strokeWidth; strokeOffset++) {
    const left = Math.max(0, minX - strokeOffset);
    const right = Math.min(png.width - 1, maxX + strokeOffset);
    const top = Math.max(0, minY - strokeOffset);
    const bottom = Math.min(png.height - 1, maxY + strokeOffset);

    for (let x = left; x <= right; x++) {
      writeRgb(png, x, top, color);
      writeRgb(png, x, bottom, color);
    }

    for (let y = top; y <= bottom; y++) {
      writeRgb(png, left, y, color);
      writeRgb(png, right, y, color);
    }
  }
}

function writeRgb(png: PNG, x: number, y: number, color: Rgb): void {
  const offset = (png.width * y + x) * 4;
  png.data[offset] = color.r;
  png.data[offset + 1] = color.g;
  png.data[offset + 2] = color.b;
  png.data[offset + 3] = 255;
}

function lighten(value: number): number {
  return Math.round(value * 0.55 + 255 * 0.45);
}

function traceChangeRegions(params: {
  mask: Uint8Array;
  width: number;
  height: number;
  baselineData: Buffer;
  currentData: Buffer;
}): ChangeRegion[] {
  const visited = new Uint8Array(params.mask.length);
  const queue = new Int32Array(params.mask.length);
  const regions: ChangeRegion[] = [];

  for (let startIndex = 0; startIndex < params.mask.length; startIndex++) {
    if (!params.mask[startIndex] || visited[startIndex]) continue;

    let queueStart = 0;
    let queueEnd = 0;
    queue[queueEnd++] = startIndex;
    visited[startIndex] = 1;

    const startX = startIndex % params.width;
    const startY = Math.floor(startIndex / params.width);
    const region: ChangeRegion = {
      minX: startX,
      minY: startY,
      maxX: startX,
      maxY: startY,
      pixelCount: 0,
      baselineSum: { r: 0, g: 0, b: 0 },
      currentSum: { r: 0, g: 0, b: 0 },
    };

    while (queueStart < queueEnd) {
      const pixelIndex = queue[queueStart++];
      const x = pixelIndex % params.width;
      const y = Math.floor(pixelIndex / params.width);
      absorbChangedPixel(region, x, y, params.baselineData, params.currentData, pixelIndex * 4);

      for (let dy = -1; dy <= 1; dy++) {
        const nextY = y + dy;
        if (nextY < 0 || nextY >= params.height) continue;

        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;

          const nextX = x + dx;
          if (nextX < 0 || nextX >= params.width) continue;

          const nextIndex = nextY * params.width + nextX;
          if (!params.mask[nextIndex] || visited[nextIndex]) continue;

          visited[nextIndex] = 1;
          queue[queueEnd++] = nextIndex;
        }
      }
    }

    regions.push(region);
  }

  return regions;
}

function absorbChangedPixel(
  region: ChangeRegion,
  x: number,
  y: number,
  baselineData: Buffer,
  currentData: Buffer,
  offset: number
): void {
  region.minX = Math.min(region.minX, x);
  region.minY = Math.min(region.minY, y);
  region.maxX = Math.max(region.maxX, x);
  region.maxY = Math.max(region.maxY, y);
  region.pixelCount++;
  region.baselineSum.r += baselineData[offset];
  region.baselineSum.g += baselineData[offset + 1];
  region.baselineSum.b += baselineData[offset + 2];
  region.currentSum.r += currentData[offset];
  region.currentSum.g += currentData[offset + 1];
  region.currentSum.b += currentData[offset + 2];
}

function joinChangeRegions(sourceRegions: ChangeRegion[], joinGapPixels: number): ChangeRegion[] {
  const regions = sourceRegions.map(copyRegion);

  if (regions.length <= 1) {
    return regions;
  }

  for (let i = 0; i < regions.length; i++) {
    let j = 0;

    while (j < regions.length) {
      if (i === j) {
        j++;
        continue;
      }

      if (shouldJoinRegions(regions[i], regions[j], joinGapPixels)) {
        regions[i] = combineRegions(regions[i], regions[j]);
        regions.splice(j, 1);

        if (j < i) {
          i--;
        }

        j = 0;
      } else {
        j++;
      }
    }
  }

  return regions;
}

function shouldJoinRegions(a: ChangeRegion, b: ChangeRegion, joinGapPixels: number): boolean {
  const dx = a.maxX < b.minX ? b.minX - a.maxX - 1 : b.maxX < a.minX ? a.minX - b.maxX - 1 : 0;
  const dy = a.maxY < b.minY ? b.minY - a.maxY - 1 : b.maxY < a.minY ? a.minY - b.maxY - 1 : 0;
  const regionGapDistance = Math.sqrt(dx * dx + dy * dy);
  if (regionGapDistance <= joinGapPixels) return true;
  return joinGapPixels > 0 && seemsLikeOneTextRow(a, b);
}

function copyRegion(region: ChangeRegion): ChangeRegion {
  return {
    minX: region.minX,
    minY: region.minY,
    maxX: region.maxX,
    maxY: region.maxY,
    pixelCount: region.pixelCount,
    baselineSum: { ...region.baselineSum },
    currentSum: { ...region.currentSum },
  };
}

function seemsLikeOneTextRow(a: ChangeRegion, b: ChangeRegion): boolean {
  const horizontalGap = regionHorizontalGap(a, b);
  if (horizontalGap <= 0) return false;

  const heightA = regionHeight(a);
  const heightB = regionHeight(b);
  const maxHeight = Math.max(heightA, heightB);
  const minHeight = Math.min(heightA, heightB);
  const allowedGap = Math.min(
    HORIZONTAL_TEXT_MERGE_MAX_GAP,
    Math.max(HORIZONTAL_TEXT_MERGE_MIN_GAP, maxHeight * HORIZONTAL_TEXT_MERGE_HEIGHT_MULTIPLIER)
  );
  if (horizontalGap > allowedGap) return false;

  const verticalOverlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1;
  if (verticalOverlap > 0 && verticalOverlap / minHeight >= 0.5) return true;

  const centerDistance = Math.abs(regionCenterY(a) - regionCenterY(b));
  return centerDistance <= Math.max(4, minHeight * 0.6);
}

function regionHorizontalGap(a: ChangeRegion, b: ChangeRegion): number {
  if (a.maxX < b.minX) return b.minX - a.maxX - 1;
  if (b.maxX < a.minX) return a.minX - b.maxX - 1;
  return 0;
}

function regionHeight(region: ChangeRegion): number {
  return region.maxY - region.minY + 1;
}

function regionCenterY(region: ChangeRegion): number {
  return (region.minY + region.maxY) / 2;
}

function combineRegions(a: ChangeRegion, b: ChangeRegion): ChangeRegion {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    pixelCount: a.pixelCount + b.pixelCount,
    baselineSum: {
      r: a.baselineSum.r + b.baselineSum.r,
      g: a.baselineSum.g + b.baselineSum.g,
      b: a.baselineSum.b + b.baselineSum.b,
    },
    currentSum: {
      r: a.currentSum.r + b.currentSum.r,
      g: a.currentSum.g + b.currentSum.g,
      b: a.currentSum.b + b.currentSum.b,
    },
  };
}

function toDiffRegion(region: ChangeRegion): DiffRegion {
  const baseline = averageRgb(region.baselineSum, region.pixelCount);
  const current = averageRgb(region.currentSum, region.pixelCount);
  const delta = {
    r: current.r - baseline.r,
    g: current.g - baseline.g,
    b: current.b - baseline.b,
  };
  const luminanceDelta = roundToOne(luminance(current) - luminance(baseline));

  return {
    bounds: {
      x: region.minX,
      y: region.minY,
      width: region.maxX - region.minX + 1,
      height: region.maxY - region.minY + 1,
    },
    pixelCount: region.pixelCount,
    averageColor: {
      delta,
      dominantChange: dominantChange(delta, luminanceDelta),
    },
  };
}

function averageRgb(sum: Rgb, pixelCount: number): Rgb {
  return {
    r: Math.round(sum.r / pixelCount),
    g: Math.round(sum.g / pixelCount),
    b: Math.round(sum.b / pixelCount),
  };
}

function luminance(rgb: Rgb): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function dominantChange(delta: Rgb, luminanceDelta: number): DominantColorChange {
  if (isUniformBrightnessDelta(delta)) {
    if (luminanceDelta === 0) {
      return { channel: "none", direction: "none", magnitude: 0 };
    }
    return {
      channel: "luminance",
      direction: luminanceDelta > 0 ? "increase" : "decrease",
      magnitude: roundToOne(Math.abs(luminanceDelta)),
    };
  }

  const candidates = [
    { channel: "red" as const, value: delta.r },
    { channel: "green" as const, value: delta.g },
    { channel: "blue" as const, value: delta.b },
    { channel: "luminance" as const, value: luminanceDelta },
  ];
  const winner = candidates.reduce((best, candidate) =>
    Math.abs(candidate.value) > Math.abs(best.value) ? candidate : best
  );

  if (winner.value === 0) {
    return { channel: "none", direction: "none", magnitude: 0 };
  }

  return {
    channel: winner.channel,
    direction: winner.value > 0 ? "increase" : "decrease",
    magnitude: roundToOne(Math.abs(winner.value)),
  };
}

function isUniformBrightnessDelta(delta: Rgb): boolean {
  if (delta.r === 0 && delta.g === 0 && delta.b === 0) return false;

  const allIncreasing = delta.r > 0 && delta.g > 0 && delta.b > 0;
  const allDecreasing = delta.r < 0 && delta.g < 0 && delta.b < 0;
  if (!allIncreasing && !allDecreasing) return false;

  const magnitudes = [Math.abs(delta.r), Math.abs(delta.g), Math.abs(delta.b)];
  return Math.max(...magnitudes) - Math.min(...magnitudes) <= UNIFORM_BRIGHTNESS_DELTA_TOLERANCE;
}

function roundToOne(value: number): number {
  return Math.round(value * 10) / 10;
}
