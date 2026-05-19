import type { DiffBounds, Rgb } from "./screenshot-diff";
import type { TextRegion } from "./text-diff";

export interface FontGeometryImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface RgbDelta {
  r: number;
  g: number;
  b: number;
}

export type FontGeometryReasonCode =
  | "ssim_delta"
  | "hog_delta"
  | "bbox_geometry_delta"
  | "glyph_density_delta"
  | "stroke_width_delta"
  | "text_color_delta"
  | "text_contrast_delta"
  | "baseline_delta"
  | "component_shape_delta"
  | "per_word_aspect_delta";

export interface FontGeometryEvidence {
  score: number;
  rawScore: number;
  confidence: number;
  reasonCodes: FontGeometryReasonCode[];
  metrics: {
    ssim: number;
    hogDistance: number;
    bboxDelta: {
      widthRatio: number;
      heightRatio: number;
      aspectRatioDelta: number;
    };
    glyphDensityDelta: number;
    strokeWidthDelta: number;
    textColorDelta: RgbDelta;
    textColorDistance: number;
    textContrastDelta: number;
    baselineDelta: number;
    componentDelta: number;
    perWordAspectDelta?: number;
  };
  baselineFeatures: FontGeometryFeatures;
  currentFeatures: FontGeometryFeatures;
}

export interface FontGeometryFeatures {
  /** Original OCR/text bounds in image coordinates. */
  bounds: DiffBounds;
  /** Alias for bounds; kept explicit so all feature geometry is image-space. */
  regionBounds: DiffBounds;
  /** Actual sampled crop including detector padding, in image coordinates. */
  cropBounds: DiffBounds;
  /** Detected ink bounds in image coordinates. */
  inkBounds?: DiffBounds;
  glyphDensity: number;
  strokeWidth: number;
  textColor?: Rgb;
  textContrast?: number;
  componentCount: number;
  inkBottomY?: number;
  inkBottomOffsetY?: number;
}

interface GrayscaleCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  values: Float64Array;
  mask: Uint8Array;
  colors: Uint8Array;
  backgroundLuminance: number;
}

interface ComponentStats {
  count: number;
  averageArea: number;
}

const MIN_FONT_SCORE = 0.58;
const MIN_TEXT_AREA = 24;
const CROP_PADDING_PX = 2;
const RESAMPLED_SIZE = 32;
const COMPONENT_RESAMPLED_SIZE = 64;
const HOG_BINS = 8;
const MIN_INK_LUMINANCE_DELTA = 24;
const MIN_ADAPTIVE_INK_LUMINANCE_DELTA = 12;

export function detectFontGeometryChange(params: {
  baselineImage: FontGeometryImage;
  currentImage: FontGeometryImage;
  baselineRegion: TextRegion;
  currentRegion: TextRegion;
}): FontGeometryEvidence | null {
  if (!hasValidImageBuffer(params.baselineImage) || !hasValidImageBuffer(params.currentImage)) {
    return null;
  }

  if (
    !hasValidBounds(params.baselineRegion.bounds) ||
    !hasValidBounds(params.currentRegion.bounds)
  ) {
    return null;
  }

  if (
    params.baselineRegion.bounds.width * params.baselineRegion.bounds.height < MIN_TEXT_AREA ||
    params.currentRegion.bounds.width * params.currentRegion.bounds.height < MIN_TEXT_AREA
  ) {
    return null;
  }

  const baselineCrop = cropToGrayscale(params.baselineImage, params.baselineRegion.bounds);
  const currentCrop = cropToGrayscale(params.currentImage, params.currentRegion.bounds);
  if (!baselineCrop || !currentCrop) return null;

  const baselineFeatures = extractFontGeometryFeatures(params.baselineRegion.bounds, baselineCrop);
  const currentFeatures = extractFontGeometryFeatures(params.currentRegion.bounds, currentCrop);
  if (baselineFeatures.glyphDensity === 0 || currentFeatures.glyphDensity === 0) return null;

  const baselineShapeCrop = cropToInkBounds(
    params.baselineImage,
    baselineFeatures,
    baselineCrop
  );
  const currentShapeCrop = cropToInkBounds(params.currentImage, currentFeatures, currentCrop);
  const baselineNormalized = resampleGrayscalePreservingAspect(baselineShapeCrop, RESAMPLED_SIZE);
  const currentNormalized = resampleGrayscalePreservingAspect(currentShapeCrop, RESAMPLED_SIZE);
  const baselineShapeValues = normalizedInkStrength(
    baselineNormalized,
    baselineFeatures.textContrast
  );
  const currentShapeValues = normalizedInkStrength(currentNormalized, currentFeatures.textContrast);
  const ssim = structuralSimilarity(baselineShapeValues, currentShapeValues);
  const hogDistance = histogramDistance(
    gradientHistogram(baselineShapeValues, RESAMPLED_SIZE, RESAMPLED_SIZE),
    gradientHistogram(currentShapeValues, RESAMPLED_SIZE, RESAMPLED_SIZE)
  );

  const widthRatio = relativeDelta(
    params.baselineRegion.bounds.width,
    params.currentRegion.bounds.width
  );
  const heightRatio = relativeDelta(
    params.baselineRegion.bounds.height,
    params.currentRegion.bounds.height
  );
  const aspectRatioDelta = relativeDelta(
    aspectRatio(params.baselineRegion.bounds),
    aspectRatio(params.currentRegion.bounds)
  );
  const glyphDensityDelta = Math.abs(currentFeatures.glyphDensity - baselineFeatures.glyphDensity);
  const strokeWidthDelta = relativeDelta(baselineFeatures.strokeWidth, currentFeatures.strokeWidth);
  const textColorDelta = colorDelta(baselineFeatures.textColor, currentFeatures.textColor);
  const textColorDistance = colorDistance(textColorDelta);
  const textContrastDelta =
    baselineFeatures.textContrast === undefined || currentFeatures.textContrast === undefined
      ? 0
      : Math.abs(currentFeatures.textContrast - baselineFeatures.textContrast);
  const baselineDelta =
    baselineFeatures.inkBottomOffsetY === undefined ||
    currentFeatures.inkBottomOffsetY === undefined
      ? 0
      : Math.abs(currentFeatures.inkBottomOffsetY - baselineFeatures.inkBottomOffsetY);
  const baselineComponentMask = resampleGrayscalePreservingAspect(
    baselineShapeCrop,
    COMPONENT_RESAMPLED_SIZE
  );
  const currentComponentMask = resampleGrayscalePreservingAspect(
    currentShapeCrop,
    COMPONENT_RESAMPLED_SIZE
  );
  const componentDelta = componentShapeDelta(baselineComponentMask.mask, currentComponentMask.mask);
  const perWordAspectDelta = averagePerWordAspectDelta(
    params.baselineRegion.words,
    params.currentRegion.words
  );

  const reasonCodes: FontGeometryReasonCode[] = [];
  const addReason = (condition: boolean, reasonCode: FontGeometryReasonCode) => {
    if (condition) reasonCodes.push(reasonCode);
  };

  addReason(ssim < 0.86, "ssim_delta");
  addReason(hogDistance > 0.18, "hog_delta");
  addReason(
    widthRatio > 0.08 || heightRatio > 0.08 || aspectRatioDelta > 0.12,
    "bbox_geometry_delta"
  );
  addReason(glyphDensityDelta > 0.045, "glyph_density_delta");
  addReason(strokeWidthDelta > 0.16, "stroke_width_delta");
  addReason(textColorDistance > 32, "text_color_delta");
  addReason(textContrastDelta > 24, "text_contrast_delta");
  addReason(
    baselineDelta > Math.max(2, params.baselineRegion.bounds.height * 0.12),
    "baseline_delta"
  );
  addReason(componentDelta > 0.18, "component_shape_delta");
  addReason((perWordAspectDelta ?? 0) > 0.12, "per_word_aspect_delta");

  const rawScore = clamp01(
    Math.min(1, Math.max(0, (0.86 - ssim) / 0.28)) * 0.22 +
      Math.min(1, hogDistance / 0.34) * 0.09 +
      Math.min(1, Math.max(widthRatio, heightRatio, aspectRatioDelta) / 0.18) * 0.13 +
      Math.min(1, glyphDensityDelta / 0.09) * 0.13 +
      Math.min(1, strokeWidthDelta / 0.35) * 0.15 +
      Math.min(1, textColorDistance / 96) * 0.08 +
      Math.min(1, textContrastDelta / 64) * 0.06 +
      Math.min(1, baselineDelta / Math.max(1, params.baselineRegion.bounds.height * 0.25)) * 0.04 +
      Math.min(1, componentDelta / 0.35) * 0.07 +
      Math.min(1, (perWordAspectDelta ?? 0) / 0.25) * 0.03
  );

  const hasStrongSingleReason =
    strokeWidthDelta > 0.35 ||
    Math.max(widthRatio, heightRatio, aspectRatioDelta) > 0.18 ||
    textColorDistance > 80 ||
    textContrastDelta > 80 ||
    ssim < 0.65 ||
    baselineDelta > Math.max(4, params.baselineRegion.bounds.height * 0.25);

  if ((rawScore < MIN_FONT_SCORE || reasonCodes.length < 2) && !hasStrongSingleReason) return null;
  const score = hasStrongSingleReason ? Math.max(rawScore, MIN_FONT_SCORE) : rawScore;
  const ocrConfidence = Math.min(
    params.baselineRegion.confidence ?? 1,
    params.currentRegion.confidence ?? 1
  );
  const confidenceScore = Math.max(
    rawScore,
    hasStrongSingleReason ? MIN_FONT_SCORE + 0.08 : MIN_FONT_SCORE
  );
  const decisionConfidence =
    0.72 + ((confidenceScore - MIN_FONT_SCORE) / (1 - MIN_FONT_SCORE)) * 0.28;

  return {
    score: round(score),
    rawScore: round(rawScore),
    confidence: round(clamp01(decisionConfidence * ocrConfidence)),
    reasonCodes,
    metrics: {
      ssim: round(ssim),
      hogDistance: round(hogDistance),
      bboxDelta: {
        widthRatio: round(widthRatio),
        heightRatio: round(heightRatio),
        aspectRatioDelta: round(aspectRatioDelta),
      },
      glyphDensityDelta: round(glyphDensityDelta),
      strokeWidthDelta: round(strokeWidthDelta),
      textColorDelta,
      textColorDistance: round(textColorDistance),
      textContrastDelta: round(textContrastDelta),
      baselineDelta: round(baselineDelta),
      componentDelta: round(componentDelta),
      ...(perWordAspectDelta === undefined
        ? {}
        : { perWordAspectDelta: round(perWordAspectDelta) }),
    },
    baselineFeatures,
    currentFeatures,
  };
}

function cropToGrayscale(image: FontGeometryImage, bounds: DiffBounds): GrayscaleCrop | null {
  const cropBounds = clampBounds(expandBounds(bounds, CROP_PADDING_PX), image.width, image.height);
  if (cropBounds.width <= 0 || cropBounds.height <= 0) return null;

  const values = new Float64Array(cropBounds.width * cropBounds.height);
  const colors = new Uint8Array(cropBounds.width * cropBounds.height * 3);
  const borderValues: number[] = [];

  for (let y = 0; y < cropBounds.height; y++) {
    for (let x = 0; x < cropBounds.width; x++) {
      const sourceOffset = ((cropBounds.y + y) * image.width + cropBounds.x + x) * 4;
      const targetIndex = y * cropBounds.width + x;
      const colorOffset = targetIndex * 3;
      const red = image.data[sourceOffset];
      const green = image.data[sourceOffset + 1];
      const blue = image.data[sourceOffset + 2];
      const alpha = image.data[sourceOffset + 3] / 255;
      colors[colorOffset] = Math.round(red * alpha + 255 * (1 - alpha));
      colors[colorOffset + 1] = Math.round(green * alpha + 255 * (1 - alpha));
      colors[colorOffset + 2] = Math.round(blue * alpha + 255 * (1 - alpha));
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const value = luminance * alpha + 255 * (1 - alpha);
      values[targetIndex] = value;
      if (x === 0 || y === 0 || x === cropBounds.width - 1 || y === cropBounds.height - 1) {
        borderValues.push(value);
      }
    }
  }

  const background = median(borderValues);
  const luminanceDeltas = Array.from(values, (value) => Math.abs(value - background));
  const adaptiveThreshold = Math.max(
    MIN_ADAPTIVE_INK_LUMINANCE_DELTA,
    Math.min(MIN_INK_LUMINANCE_DELTA, percentile(luminanceDeltas, 0.8) * 0.35)
  );
  const mask = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index++) {
    if (Math.abs(values[index] - background) >= adaptiveThreshold) mask[index] = 1;
  }

  return {
    x: cropBounds.x,
    y: cropBounds.y,
    width: cropBounds.width,
    height: cropBounds.height,
    values,
    mask,
    colors,
    backgroundLuminance: background,
  };
}

function extractFontGeometryFeatures(
  bounds: DiffBounds,
  crop: GrayscaleCrop
): FontGeometryFeatures {
  const localInkBounds = maskBounds(crop.mask, crop.width, crop.height);
  const inkBounds = localInkBounds ? translateBounds(localInkBounds, crop.x, crop.y) : undefined;
  const glyphPixels = countMask(crop.mask);
  const glyphDensity = glyphPixels / (crop.width * crop.height);
  return {
    bounds,
    regionBounds: bounds,
    cropBounds: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
    ...(inkBounds ? { inkBounds } : {}),
    glyphDensity,
    strokeWidth: averageStrokeWidth(crop.mask, crop.width, crop.height),
    ...(glyphPixels > 0
      ? { textColor: averageInkColor(crop), textContrast: textContrast(crop) }
      : {}),
    componentCount: connectedComponentStats(crop.mask, crop.width, crop.height).count,
    ...(inkBounds
      ? {
          inkBottomY: inkBounds.y + inkBounds.height,
          inkBottomOffsetY: inkBounds.y + inkBounds.height - bounds.y,
        }
      : {}),
  };
}

function cropToInkBounds(
  image: FontGeometryImage,
  features: FontGeometryFeatures,
  fallback: GrayscaleCrop
): GrayscaleCrop {
  if (!features.inkBounds) return fallback;
  return cropToGrayscale(image, features.inkBounds) ?? fallback;
}

function structuralSimilarity(left: Float64Array, right: Float64Array): number {
  const n = Math.min(left.length, right.length);
  if (n === 0) return 1;

  let meanLeft = 0;
  let meanRight = 0;
  for (let index = 0; index < n; index++) {
    meanLeft += left[index];
    meanRight += right[index];
  }
  meanLeft /= n;
  meanRight /= n;

  let varianceLeft = 0;
  let varianceRight = 0;
  let covariance = 0;
  for (let index = 0; index < n; index++) {
    const dl = left[index] - meanLeft;
    const dr = right[index] - meanRight;
    varianceLeft += dl * dl;
    varianceRight += dr * dr;
    covariance += dl * dr;
  }
  const denominator = Math.max(1, n - 1);
  varianceLeft /= denominator;
  varianceRight /= denominator;
  covariance /= denominator;

  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const value =
    ((2 * meanLeft * meanRight + c1) * (2 * covariance + c2)) /
    ((meanLeft ** 2 + meanRight ** 2 + c1) * (varianceLeft + varianceRight + c2));
  return clamp01(value);
}

function gradientHistogram(values: Float64Array, width: number, height: number): number[] {
  const bins = new Array<number>(HOG_BINS).fill(0);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx = values[y * width + x + 1] - values[y * width + x - 1];
      const gy = values[(y + 1) * width + x] - values[(y - 1) * width + x];
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      if (magnitude < 1) continue;
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      if (angle >= Math.PI) angle -= Math.PI;
      const bin = Math.min(HOG_BINS - 1, Math.floor((angle / Math.PI) * HOG_BINS));
      bins[bin] += magnitude;
    }
  }
  const total = bins.reduce((sum, value) => sum + value, 0);
  return total === 0 ? bins : bins.map((value) => value / total);
}

function histogramDistance(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    sum += Math.abs(left[index] - right[index]);
  }
  return sum / 2;
}

function normalizedInkStrength(
  crop: GrayscaleCrop,
  textContrast: number | undefined
): Float64Array {
  const values = new Float64Array(crop.values.length);
  const contrast = Math.max(1, textContrast ?? maxLuminanceDelta(crop));
  for (let index = 0; index < crop.values.length; index++) {
    values[index] =
      clamp01(Math.abs(crop.values[index] - crop.backgroundLuminance) / contrast) * 255;
  }
  return values;
}

function maxLuminanceDelta(crop: GrayscaleCrop): number {
  let max = 0;
  for (let index = 0; index < crop.values.length; index++) {
    max = Math.max(max, Math.abs(crop.values[index] - crop.backgroundLuminance));
  }
  return max;
}

function resampleGrayscalePreservingAspect(crop: GrayscaleCrop, size: number): GrayscaleCrop {
  const values = new Float64Array(size * size);
  const mask = new Uint8Array(size * size);
  const colors = new Uint8Array(size * size * 3);
  values.fill(crop.backgroundLuminance);
  colors.fill(Math.round(crop.backgroundLuminance));

  const scale = Math.min(size / crop.width, size / crop.height);
  const scaledWidth = Math.max(1, crop.width * scale);
  const scaledHeight = Math.max(1, crop.height * scale);
  const offsetX = (size - scaledWidth) / 2;
  const offsetY = (size - scaledHeight) / 2;

  for (let y = 0; y < size; y++) {
    const sourceY = (y - offsetY + 0.5) / scale - 0.5;
    if (sourceY < 0 || sourceY > crop.height - 1) continue;
    for (let x = 0; x < size; x++) {
      const sourceX = (x - offsetX + 0.5) / scale - 0.5;
      if (sourceX < 0 || sourceX > crop.width - 1) continue;

      const targetIndex = y * size + x;
      values[targetIndex] = bilinearSample(crop.values, crop.width, crop.height, sourceX, sourceY);
      mask[targetIndex] =
        bilinearSample(crop.mask, crop.width, crop.height, sourceX, sourceY) >= 0.5 ? 1 : 0;

      const targetColorOffset = targetIndex * 3;
      for (let channel = 0; channel < 3; channel++) {
        colors[targetColorOffset + channel] = Math.round(
          bilinearSampleColor(crop.colors, crop.width, crop.height, sourceX, sourceY, channel)
        );
      }
    }
  }

  return {
    x: 0,
    y: 0,
    width: size,
    height: size,
    values,
    mask,
    colors,
    backgroundLuminance: crop.backgroundLuminance,
  };
}

function bilinearSample(
  values: Float64Array | Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number
): number {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;
  const top = values[y0 * width + x0] * (1 - tx) + values[y0 * width + x1] * tx;
  const bottom = values[y1 * width + x0] * (1 - tx) + values[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function bilinearSampleColor(
  colors: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  channel: number
): number {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;
  const top =
    colors[(y0 * width + x0) * 3 + channel] * (1 - tx) +
    colors[(y0 * width + x1) * 3 + channel] * tx;
  const bottom =
    colors[(y1 * width + x0) * 3 + channel] * (1 - tx) +
    colors[(y1 * width + x1) * 3 + channel] * tx;
  return top * (1 - ty) + bottom * ty;
}

function averageStrokeWidth(mask: Uint8Array, width: number, height: number): number {
  let total = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!mask[index]) continue;
      total += Math.min(
        runLength(mask, width, height, x, y, 1, 0),
        runLength(mask, width, height, x, y, 0, 1)
      );
      count++;
    }
  }
  return count === 0 ? 0 : total / count;
}

function averageInkColor(crop: GrayscaleCrop): Rgb {
  const sum = { r: 0, g: 0, b: 0 };
  let count = 0;
  for (let index = 0; index < crop.mask.length; index++) {
    if (!crop.mask[index]) continue;
    const colorOffset = index * 3;
    sum.r += crop.colors[colorOffset];
    sum.g += crop.colors[colorOffset + 1];
    sum.b += crop.colors[colorOffset + 2];
    count++;
  }

  if (count === 0) return { r: 0, g: 0, b: 0 };
  return {
    r: Math.round(sum.r / count),
    g: Math.round(sum.g / count),
    b: Math.round(sum.b / count),
  };
}

function textContrast(crop: GrayscaleCrop): number {
  const inkColor = averageInkColor(crop);
  return Math.abs(luminance(inkColor) - crop.backgroundLuminance);
}

function colorDelta(left?: Rgb, right?: Rgb): RgbDelta {
  if (!left || !right) return { r: 0, g: 0, b: 0 };
  return {
    r: right.r - left.r,
    g: right.g - left.g,
    b: right.b - left.b,
  };
}

function colorDistance(delta: RgbDelta): number {
  return Math.sqrt(delta.r * delta.r + delta.g * delta.g + delta.b * delta.b);
}

function luminance(rgb: Rgb): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function runLength(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  dx: number,
  dy: number
): number {
  let length = 1;
  for (
    let nextX = x + dx, nextY = y + dy;
    inBounds(nextX, nextY, width, height);
    nextX += dx, nextY += dy
  ) {
    if (!mask[nextY * width + nextX]) break;
    length++;
  }
  for (
    let nextX = x - dx, nextY = y - dy;
    inBounds(nextX, nextY, width, height);
    nextX -= dx, nextY -= dy
  ) {
    if (!mask[nextY * width + nextX]) break;
    length++;
  }
  return length;
}

function componentShapeDelta(leftMask: Uint8Array, rightMask: Uint8Array): number {
  const side = Math.sqrt(leftMask.length);
  if (!Number.isInteger(side) || leftMask.length !== rightMask.length) return 0;
  const left = connectedComponentStats(leftMask, side, side);
  const right = connectedComponentStats(rightMask, side, side);
  return Math.max(
    relativeDelta(left.count, right.count),
    relativeDelta(left.averageArea, right.averageArea)
  );
}

function connectedComponentStats(mask: Uint8Array, width: number, height: number): ComponentStats {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const minComponentArea = Math.max(2, Math.floor(mask.length * 0.0005));
  let count = 0;
  let totalArea = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let area = 0;
    let queueStart = 0;
    let queueEnd = 0;
    queue[queueEnd++] = start;
    visited[start] = 1;

    while (queueStart < queueEnd) {
      const index = queue[queueStart++];
      area++;
      const x = index % width;
      const y = Math.floor(index / width);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (!inBounds(nextX, nextY, width, height)) continue;
        const nextIndex = nextY * width + nextX;
        if (!mask[nextIndex] || visited[nextIndex]) continue;
        visited[nextIndex] = 1;
        queue[queueEnd++] = nextIndex;
      }
    }
    if (area >= minComponentArea) {
      count++;
      totalArea += area;
    }
  }

  return { count, averageArea: count === 0 ? 0 : totalArea / count };
}

function maskBounds(mask: Uint8Array, width: number, height: number): DiffBounds | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (!Number.isFinite(minX)) return undefined;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function averagePerWordAspectDelta(
  baselineWords: TextRegion["words"],
  currentWords: TextRegion["words"]
): number | undefined {
  if (
    !baselineWords ||
    !currentWords ||
    baselineWords.length === 0 ||
    baselineWords.length !== currentWords.length
  ) {
    return undefined;
  }
  let total = 0;
  for (let index = 0; index < baselineWords.length; index++) {
    if (
      normalizeWordForAspect(baselineWords[index].text) !==
      normalizeWordForAspect(currentWords[index].text)
    ) {
      return undefined;
    }
    total += relativeDelta(
      aspectRatio(baselineWords[index].bounds),
      aspectRatio(currentWords[index].bounds)
    );
  }
  return total / baselineWords.length;
}

function normalizeWordForAspect(text: string): string {
  return text.trim().normalize("NFKC").toLowerCase();
}

function countMask(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) count += value;
  return count;
}

function relativeDelta(left: number, right: number): number {
  const denominator = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(right - left) / denominator;
}

function aspectRatio(bounds: DiffBounds): number {
  return bounds.height <= 0 ? 0 : bounds.width / bounds.height;
}

function expandBounds(bounds: DiffBounds, padding: number): DiffBounds {
  return {
    x: Math.floor(bounds.x - padding),
    y: Math.floor(bounds.y - padding),
    width: Math.ceil(bounds.width + padding * 2),
    height: Math.ceil(bounds.height + padding * 2),
  };
}

function translateBounds(bounds: DiffBounds, x: number, y: number): DiffBounds {
  return { x: bounds.x + x, y: bounds.y + y, width: bounds.width, height: bounds.height };
}

function hasValidImageBuffer(image: FontGeometryImage): boolean {
  return (
    Number.isInteger(image.width) &&
    Number.isInteger(image.height) &&
    image.width > 0 &&
    image.height > 0 &&
    image.data.length >= image.width * image.height * 4
  );
}

function hasValidBounds(bounds: DiffBounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function clampBounds(bounds: DiffBounds, width: number, height: number): DiffBounds {
  const x = Math.max(0, bounds.x);
  const y = Math.max(0, bounds.y);
  const right = Math.min(width, bounds.x + bounds.width);
  const bottom = Math.min(height, bounds.y + bounds.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function median(values: number[]): number {
  if (values.length === 0) return 255;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue))
  );
  return sorted[index];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
