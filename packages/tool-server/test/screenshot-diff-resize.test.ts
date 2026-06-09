import { describe, expect, it } from "vitest";
import {
  normalizeToCommonSize,
  resizeDecodedPng,
  type DecodedRgbaImage,
} from "../src/tools/screenshot-diff/resize";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function solidImage(width: number, height: number, color: Rgb): DecodedRgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    data[offset] = color.r;
    data[offset + 1] = color.g;
    data[offset + 2] = color.b;
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

// A deterministic gradient so resampling has real signal to work with.
function gradientImage(width: number, height: number): DecodedRgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = Math.round((x / Math.max(1, width - 1)) * 255);
      data[offset + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      data[offset + 2] = 128;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

function pixelAt(image: DecodedRgbaImage, x: number, y: number): Rgb {
  const offset = (y * image.width + x) * 4;
  return {
    r: image.data[offset],
    g: image.data[offset + 1],
    b: image.data[offset + 2],
  };
}

describe("resizeDecodedPng", () => {
  it("downscales to the requested dimensions with a correctly-sized RGBA buffer", () => {
    const resized = resizeDecodedPng(gradientImage(30, 60), 10, 20);
    expect(resized.width).toBe(10);
    expect(resized.height).toBe(20);
    expect(resized.data.length).toBe(10 * 20 * 4);
  });

  it("returns a detached copy when the size is unchanged", () => {
    const source = solidImage(8, 8, { r: 10, g: 20, b: 30 });
    const resized = resizeDecodedPng(source, 8, 8);
    expect(resized.width).toBe(8);
    expect(resized.height).toBe(8);
    expect(resized.data).not.toBe(source.data);
    expect(Buffer.compare(resized.data, source.data)).toBe(0);
  });

  it("preserves a uniform color when downscaling", () => {
    const resized = resizeDecodedPng(solidImage(30, 60, { r: 200, g: 100, b: 50 }), 10, 20);
    // Resampling a flat field must reproduce the same color everywhere.
    expect(pixelAt(resized, 0, 0)).toEqual({ r: 200, g: 100, b: 50 });
    expect(pixelAt(resized, 5, 10)).toEqual({ r: 200, g: 100, b: 50 });
    expect(pixelAt(resized, 9, 19)).toEqual({ r: 200, g: 100, b: 50 });
  });
});

describe("normalizeToCommonSize", () => {
  it("returns both images untouched when dimensions already match", () => {
    const baseline = gradientImage(10, 20);
    const current = gradientImage(10, 20);
    const result = normalizeToCommonSize(baseline, current);
    expect(result).not.toBeNull();
    expect(result!.baseline).toBe(baseline);
    expect(result!.current).toBe(current);
  });

  it("downscales the larger same-aspect image to the smaller common size", () => {
    // Case 1: same aspect (0.5), different size -> both end up at 10x20.
    const baseline = gradientImage(30, 60);
    const current = gradientImage(10, 20);
    const result = normalizeToCommonSize(baseline, current);

    expect(result).not.toBeNull();
    expect(result!.baseline.width).toBe(10);
    expect(result!.baseline.height).toBe(20);
    expect(result!.current.width).toBe(10);
    expect(result!.current.height).toBe(20);
    // Baseline was the larger image, so it must have been resampled to a new buffer.
    expect(result!.baseline.data.length).toBe(10 * 20 * 4);
    expect(result!.baseline.data).not.toBe(baseline.data);
    // The smaller image is passed through untouched.
    expect(result!.current).toBe(current);
  });

  it("downscales the larger side regardless of which argument it is", () => {
    // Larger image supplied as `current` this time -> it is the one resized.
    const baseline = gradientImage(10, 20);
    const current = gradientImage(30, 60);
    const result = normalizeToCommonSize(baseline, current);

    expect(result).not.toBeNull();
    expect(result!.baseline).toBe(baseline);
    expect(result!.current.width).toBe(10);
    expect(result!.current.height).toBe(20);
    expect(result!.current.data.length).toBe(10 * 20 * 4);
  });

  it("keeps identical scaled content consistent without crashing", () => {
    // Case 2: same content at two scales -> normalized outputs share dims and
    // the uniform color survives the resample.
    const baseline = solidImage(30, 60, { r: 12, g: 34, b: 56 });
    const current = solidImage(10, 20, { r: 12, g: 34, b: 56 });
    const result = normalizeToCommonSize(baseline, current);

    expect(result).not.toBeNull();
    expect(result!.baseline.width).toBe(result!.current.width);
    expect(result!.baseline.height).toBe(result!.current.height);
    expect(result!.baseline.width).toBe(10);
    expect(result!.baseline.height).toBe(20);
    expect(pixelAt(result!.baseline, 4, 9)).toEqual({ r: 12, g: 34, b: 56 });
    expect(pixelAt(result!.current, 4, 9)).toEqual({ r: 12, g: 34, b: 56 });
  });

  it("normalizes when aspect ratios differ within the 1% tolerance", () => {
    // 0.5 vs 0.4995 aspect (~0.1% difference) -> treated as the same framebuffer.
    const baseline = gradientImage(1000, 2000);
    const current = gradientImage(999, 2000);
    const result = normalizeToCommonSize(baseline, current);

    expect(result).not.toBeNull();
    expect(result!.baseline.width).toBe(result!.current.width);
    expect(result!.baseline.height).toBe(result!.current.height);
  });

  it("returns null for a transposed aspect ratio", () => {
    // Case 3a: 20x10 (2.0) vs 10x20 (0.5).
    const result = normalizeToCommonSize(gradientImage(20, 10), gradientImage(10, 20));
    expect(result).toBeNull();
  });

  it("returns null when aspect ratios differ beyond the tolerance", () => {
    // Case 3b: 0.5 vs ~0.476 aspect (~4.8% difference) exceeds the 1% tolerance.
    const result = normalizeToCommonSize(gradientImage(100, 200), gradientImage(100, 210));
    expect(result).toBeNull();
  });

  it("returns null for a degenerate zero-dimension image", () => {
    const result = normalizeToCommonSize(
      { width: 0, height: 0, data: Buffer.alloc(0) },
      gradientImage(10, 20)
    );
    expect(result).toBeNull();
  });
});
