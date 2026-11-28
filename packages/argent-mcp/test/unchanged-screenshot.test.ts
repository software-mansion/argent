import { deflateSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import {
  MAX_UNCHANGED_SCREENSHOTS_IN_A_ROW,
  UNCHANGED_SCREENSHOT_MAX_AGE_MS,
  createScreenshotMemory,
  fingerprintPng,
  screenshotIdLine,
  unchangedScreenshotNote,
} from "../src/unchanged-screenshot.js";

const MINUTE = 60_000;

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Builds a minimal valid 8-bit RGBA PNG with optional extra chunks / zlib level. */
function makeRgbaPng(
  width: number,
  height: number,
  pixels: Uint8Array,
  opts: { filterType?: 0 | 1 | 2 | 3 | 4; extraChunk?: Buffer; level?: number } = {}
): Buffer {
  const bpp = 4;
  const stride = width * bpp;
  const filterType = opts.filterType ?? 0;
  const scanlines = Buffer.alloc(height * (1 + stride));

  for (let y = 0; y < height; y++) {
    const outStart = y * (1 + stride);
    scanlines[outStart] = filterType;
    for (let x = 0; x < stride; x++) {
      const cur = pixels[y * stride + x]!;
      const a = x >= bpp ? pixels[y * stride + x - bpp]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = y > 0 && x >= bpp ? pixels[(y - 1) * stride + x - bpp]! : 0;
      let encoded = cur;
      if (filterType === 1) encoded = (cur - a) & 0xff;
      else if (filterType === 2) encoded = (cur - b) & 0xff;
      else if (filterType === 3) encoded = (cur - ((a + b) >>> 1)) & 0xff;
      else if (filterType === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        encoded = (cur - pr) & 0xff;
      }
      scanlines[outStart + 1 + x] = encoded;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const compressed = deflateSync(scanlines, { level: opts.level ?? 6 });

  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...(opts.extraChunk ? [opts.extraChunk] : []),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ];
  return Buffer.concat(chunks);
}

const PIXELS_A = new Uint8Array([
  10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
]);
const PIXELS_B = new Uint8Array([
  10,
  20,
  30,
  255,
  40,
  50,
  60,
  255,
  70,
  80,
  90,
  255,
  101,
  110,
  120,
  255, // single channel shifted by 1
]);

const PNG_A = makeRgbaPng(2, 2, PIXELS_A);
const PNG_B = makeRgbaPng(2, 2, PIXELS_B);

function memoryWithClock() {
  const clock = { now: 1_000 };
  return { clock, shots: createScreenshotMemory(() => clock.now, "s") };
}

describe("fingerprintPng", () => {
  it("produces the same digest regardless of PNG filter type, compression level, or metadata chunks", () => {
    const base = fingerprintPng(makeRgbaPng(2, 2, PIXELS_A, { filterType: 0, level: 1 }));
    for (const filterType of [1, 2, 3, 4] as const) {
      const variant = makeRgbaPng(2, 2, PIXELS_A, {
        filterType,
        level: 9,
        extraChunk: pngChunk("tEXt", Buffer.from(`Software\0test-${filterType}`)),
      });
      expect(variant.equals(PNG_A)).toBe(false);
      expect(fingerprintPng(variant)).toBe(base);
    }
  });

  it("changes digest when even a single pixel channel differs", () => {
    expect(fingerprintPng(PNG_A)).not.toBe(fingerprintPng(PNG_B));
  });

  it("falls back to hashing raw bytes for minimal/non-standard PNG buffers", () => {
    const stub1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);
    const stub2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 2]);
    expect(fingerprintPng(stub1)).toBe(fingerprintPng(Buffer.from(stub1)));
    expect(fingerprintPng(stub1)).not.toBe(fingerprintPng(stub2));
  });
});

describe("createScreenshotMemory", () => {
  it("sends the first screenshot of a device with an id, and notes identical follow-ups", () => {
    const { shots } = memoryWithClock();

    expect(shots.afterAction("u", PNG_A, "gesture-tap")).toEqual({
      id: "s-1",
      identical: false,
      note: false,
    });
    expect(shots.afterAction("u", PNG_A, "await-ui-element")).toEqual({
      noteText: unchangedScreenshotNote("s-1", "gesture-tap"),
      identical: true,
      note: true,
    });
  });

  it("sends a new screenshot under a new id when pixels change", () => {
    const { shots } = memoryWithClock();
    shots.afterAction("u", PNG_A, "gesture-tap");

    expect(shots.afterAction("u", PNG_B, "gesture-tap")).toEqual({
      id: "s-2",
      identical: false,
      note: false,
    });
    expect(shots.afterAction("u", PNG_B, "describe")).toEqual({
      noteText: unchangedScreenshotNote("s-2", "gesture-tap"),
      identical: true,
      note: true,
    });
  });

  it("compares with an explicit screenshot call and resets the count and age", () => {
    const { clock, shots } = memoryWithClock();
    shots.afterAction("u", PNG_A, "gesture-tap");
    for (let i = 0; i < 3; i++) shots.afterAction("u", PNG_A, "await-ui-element");
    clock.now += 4 * MINUTE;

    expect(shots.sent("u", PNG_A, "mcp__argent__screenshot")).toBe("s-2");
    clock.now += 4 * MINUTE;

    expect(shots.afterAction("u", PNG_A, "describe")).toEqual({
      noteText: unchangedScreenshotNote("s-2", "screenshot"),
      identical: true,
      note: true,
    });
  });

  it("sends the screenshot again after three notes in a row", () => {
    expect(MAX_UNCHANGED_SCREENSHOTS_IN_A_ROW).toBe(3);
    const { shots } = memoryWithClock();
    shots.afterAction("u", PNG_A, "gesture-tap");

    const notes = [1, 2, 3, 4, 5, 6, 7, 8].map(
      () => shots.afterAction("u", PNG_A, "await-ui-element").note
    );

    expect(notes).toEqual([true, true, true, false, true, true, true, false]);
  });

  it("sends the screenshot again once the last full one is more than five minutes old", () => {
    expect(UNCHANGED_SCREENSHOT_MAX_AGE_MS).toBe(5 * MINUTE);
    const { clock, shots } = memoryWithClock();
    shots.afterAction("u", PNG_A, "gesture-tap");

    clock.now += 5 * MINUTE;
    expect(shots.afterAction("u", PNG_A, "gesture-tap").note).toBe(true);
    clock.now += 1;
    expect(shots.afterAction("u", PNG_A, "gesture-tap")).toEqual({
      id: "s-2",
      identical: true,
      note: false,
    });
  });

  it("keeps devices apart and forgets on cancel", () => {
    const { shots } = memoryWithClock();
    shots.afterAction("ios", PNG_A, "gesture-tap");
    shots.afterAction("android", PNG_A, "gesture-tap");

    shots.forget("ios");

    expect(shots.afterAction("ios", PNG_A, "gesture-tap")).toEqual({
      id: "s-3",
      identical: false,
      note: false,
    });
    expect(shots.afterAction("android", PNG_A, "gesture-tap").note).toBe(true);
  });
});

describe("screenshotIdLine & unchangedScreenshotNote", () => {
  it("formats the id line and names the earlier screenshot and fallback tool", () => {
    expect(screenshotIdLine("k3x-7")).toBe("Screenshot id: k3x-7");
    const note = unchangedScreenshotNote("k3x-7", "gesture-tap");
    expect(note).toContain("k3x-7");
    expect(note).toContain("gesture-tap");
    expect(note).toContain("screenshot");
  });
});
