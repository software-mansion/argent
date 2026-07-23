import { describe, it, expect } from "vitest";
import { buildWatermarkGraph, computeWatermarkBox } from "../src/tools/screen-recording/watermark";

describe("computeWatermarkBox", () => {
  it("sizes the box relative to frame width and pins it bottom-left", () => {
    // 886x1920 portrait: 0.286*886~=254 wide, height keeps the 900:277 logo
    // aspect (snapped even -> 78), side inset 0.03*886~=26, bottom inset
    // 0.018*886~=16 (a touch lower), y = 1920 - h - bottomMargin.
    const box = computeWatermarkBox({ width: 886, height: 1920 });
    expect(box).toEqual({ w: 254, h: 78, x: 26, y: 1826 });
  });

  it("keeps every dimension even (yuv420p 4:2:0 crop/scale requirement)", () => {
    for (const dims of [
      { width: 886, height: 1920 },
      { width: 1170, height: 2532 },
      { width: 2048, height: 2732 },
      { width: 1920, height: 886 },
    ]) {
      const box = computeWatermarkBox(dims);
      for (const v of [box.w, box.h, box.x, box.y]) expect(v % 2).toBe(0);
    }
  });

  it("scales with resolution (wider frame -> wider watermark)", () => {
    const phone = computeWatermarkBox({ width: 886, height: 1920 });
    const tablet = computeWatermarkBox({ width: 2048, height: 2732 });
    expect(tablet.w).toBeGreaterThan(phone.w);
    // aspect of the box tracks the logo aspect on both
    expect(phone.w / phone.h).toBeCloseTo(tablet.w / tablet.h, 1);
  });

  it("never places the box off the top of a tiny frame", () => {
    const box = computeWatermarkBox({ width: 100, height: 20 });
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.w).toBeGreaterThanOrEqual(2);
    expect(box.h).toBeGreaterThanOrEqual(2);
  });

  it("never lets the crop box exceed the frame, even for pathological aspect ratios", () => {
    // A frame far wider than tall keeps the logo's 900:277 aspect, which would
    // otherwise make the box taller than the frame. ffmpeg's crop aborts (-22)
    // on a rectangle larger than the input and kills the whole recording, so
    // the box must stay inside the frame on every axis regardless of shape.
    for (const dims of [
      { width: 1000, height: 50 }, // 20:1, h would overflow the height
      { width: 2000, height: 30 }, // extreme wide-short
      { width: 40, height: 41 }, // sub-55px width, odd height rounding edge
    ]) {
      const box = computeWatermarkBox(dims);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(dims.width);
      expect(box.y + box.h).toBeLessThanOrEqual(dims.height);
      for (const v of [box.w, box.h, box.x, box.y]) expect(v % 2).toBe(0);
    }
  });
});

describe("buildWatermarkGraph", () => {
  const graph = buildWatermarkGraph({ width: 886, height: 1920 });

  it("normalizes to a constant 30fps before overlaying", () => {
    expect(graph.startsWith("[0:v]fps=30,")).toBe(true);
  });

  it("fades the whole watermark to 20% opacity (80% transparent)", () => {
    expect(graph).toContain("colorchannelmixer=aa=0.2");
  });

  it("derives a near-black twin of the white logo for light backgrounds", () => {
    expect(graph).toContain("colorchannelmixer=rr=0.08:gg=0.08:bb=0.08");
  });

  it("chooses per pixel via a background-luma mask + maskedmerge", () => {
    // ramp: white logo where bg luma <= 90, near-black where >= 165
    expect(graph).toContain("lut=y='clip((165-val)/75*255,0,255)'");
    expect(graph).toContain("maskedmerge");
  });

  it("samples the mask from exactly where the stamp lands (aligned crop+overlay)", () => {
    const box = computeWatermarkBox({ width: 886, height: 1920 });
    const crop = graph.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
    const overlay = graph.match(/overlay=(\d+):(\d+)/);
    expect(crop).not.toBeNull();
    expect(overlay).not.toBeNull();
    // crop x/y must equal overlay x/y, else the mask reads the wrong region
    expect(crop?.[3]).toBe(String(box.x));
    expect(crop?.[4]).toBe(String(box.y));
    expect(overlay?.[1]).toBe(String(box.x));
    expect(overlay?.[2]).toBe(String(box.y));
  });

  it("evens an odd-resolution base before splitting so yuv420p can encode it", () => {
    // iPhone 16 / 15 Pro / 15 / 14 Pro stream at 1179x2556 (odd width). Without
    // an even base the overlayed output stays 1179 wide and libx264 rejects it
    // ("width not divisible by 2"), killing the whole recording. Crop the base
    // to 1178 up front, and derive the box from that so the mask stays inside.
    const odd = buildWatermarkGraph({ width: 1179, height: 2556 });
    expect(odd.startsWith("[0:v]fps=30,crop=1178:2556:0:0,split=2[base][under]")).toBe(true);
    const box = computeWatermarkBox({ width: 1178, height: 2556 });
    expect(box.x + box.w).toBeLessThanOrEqual(1178);
    // the mask crop reads from within the evened base
    const maskCrop = odd.match(/\[under\]crop=(\d+):(\d+):(\d+):(\d+)/);
    expect(Number(maskCrop?.[3]) + Number(maskCrop?.[1])).toBeLessThanOrEqual(1178);
  });

  it("leaves an already-even frame's graph unchanged (no redundant base crop)", () => {
    const even = buildWatermarkGraph({ width: 1320, height: 2868 });
    expect(even.startsWith("[0:v]fps=30,split=2[base][under]")).toBe(true);
    // the only crop is the mask crop; there is no base even-crop of the frame
    expect(even).not.toMatch(/crop=1320:2868/);
  });
});
