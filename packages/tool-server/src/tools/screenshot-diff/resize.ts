// Pure (pngjs-free) image resampling helpers for screenshot-diff.
//
// This module intentionally has NO dependency on `pngjs`. It operates on a
// plain decoded-image shape (`{ width, height, data }` with tightly-packed
// RGBA bytes) so that it can be unit-tested in environments where `pngjs` is
// not runtime-resolvable. `screenshot-diff.ts` re-uses these helpers and wraps
// the results back into `pngjs` `PNG` objects where it needs them.

/**
 * Minimal decoded-image shape shared with `screenshot-diff.ts`'s `DecodedPng`
 * and `font-diff.ts`'s `FontGeometryImage`. `data` is a tightly-packed RGBA
 * byte buffer of length `width * height * 4`.
 */
export interface DecodedRgbaImage {
  width: number;
  height: number;
  data: Buffer;
}

// Aspect ratios are treated as equal when they agree within this relative
// tolerance. Uniform scalings of the same framebuffer (e.g. a 0.3x saved
// screenshot vs a 1.0x live capture) match exactly in theory but pick up tiny
// rounding error from integer pixel dimensions, so a small tolerance is needed.
const ASPECT_RATIO_TOLERANCE = 0.01;

/**
 * When two decoded images share the same aspect ratio (within
 * {@link ASPECT_RATIO_TOLERANCE}) but differ in resolution, downscale the
 * larger one to the smaller one's exact dimensions so they can be compared
 * pixel-for-pixel. The smaller image is returned untouched; we never upscale.
 *
 * Returns `null` when the aspect ratios genuinely differ — callers should keep
 * treating that as a hard dimension mismatch.
 */
export function normalizeToCommonSize(
  baseline: DecodedRgbaImage,
  current: DecodedRgbaImage
): { baseline: DecodedRgbaImage; current: DecodedRgbaImage } | null {
  if (baseline.width === current.width && baseline.height === current.height) {
    return { baseline, current };
  }

  if (!aspectRatiosMatch(baseline, current)) {
    return null;
  }

  const baselineArea = baseline.width * baseline.height;
  const currentArea = current.width * current.height;

  if (baselineArea <= currentArea) {
    return {
      baseline,
      current: resizeDecodedPng(current, baseline.width, baseline.height),
    };
  }

  return {
    baseline: resizeDecodedPng(baseline, current.width, current.height),
    current,
  };
}

function aspectRatiosMatch(a: DecodedRgbaImage, b: DecodedRgbaImage): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
    return false;
  }
  const aspectA = a.width / a.height;
  const aspectB = b.width / b.height;
  const largest = Math.max(aspectA, aspectB);
  if (largest === 0) return false;
  return Math.abs(aspectA - aspectB) / largest <= ASPECT_RATIO_TOLERANCE;
}

/**
 * Lanczos3-resample a decoded RGBA image to the target dimensions, returning a
 * new decoded image backed by a plain `Buffer`. Shared with the diff-artifact
 * downscaler in `screenshot-diff.ts`.
 */
export function resizeDecodedPng(
  src: DecodedRgbaImage,
  width: number,
  height: number
): DecodedRgbaImage {
  const targetWidth = Math.max(1, Math.round(width));
  const targetHeight = Math.max(1, Math.round(height));
  if (targetWidth === src.width && targetHeight === src.height) {
    return { width: src.width, height: src.height, data: Buffer.from(src.data) };
  }

  const horizontal = buildLanczos3AxisWeights(src.width, targetWidth);
  const vertical = buildLanczos3AxisWeights(src.height, targetHeight);

  const intermediate = new Float32Array(targetWidth * src.height * 4);
  resampleHorizontalRgba({
    sourceData: src.data,
    sourceWidth: src.width,
    sourceHeight: src.height,
    targetWidth,
    weights: horizontal,
    output: intermediate,
  });

  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  resampleVerticalRgba({
    intermediate,
    targetWidth,
    targetHeight,
    weights: vertical,
    output,
  });

  return { width: targetWidth, height: targetHeight, data: output };
}

export interface ResampleAxisWeights {
  start: number;
  weights: Float32Array;
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
