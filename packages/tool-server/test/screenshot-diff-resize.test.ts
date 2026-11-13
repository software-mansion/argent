import { describe, expect, it } from "vitest";
import { resizeDecodedPng, type DecodedRgbaImage } from "../src/tools/screenshot-diff/resize";

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
