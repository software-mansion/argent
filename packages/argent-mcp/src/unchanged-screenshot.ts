/**
 * Leaves out an auto-screenshot whose pixels match the last screenshot the
 * agent already received for the same device. No-op taps, end-of-list swipes,
 * immediate waits, or a `describe` right after an action otherwise attach a
 * duplicate PNG (hundreds to over a thousand vision tokens) that stays in
 * context for the rest of the session.
 *
 * Mirrors `unchanged-tree.ts`: every full screenshot gets a `Screenshot id`,
 * notes reference it by id and tool, and a cap on consecutive notes + max age
 * guarantees a fresh image is sent periodically. Explicit `screenshot` calls
 * always return the image and reset the baseline (unless `includeImageInContext`
 * was false, in which case the agent never saw the image).
 */

import { createHash, randomInt } from "node:crypto";
import { inflateSync } from "node:zlib";
import { normalizeToolName } from "./auto-capture.js";

/** Notes sent in a row for one screenshot before the image is sent again. */
export const MAX_UNCHANGED_SCREENSHOTS_IN_A_ROW = 3;

/** Age of the last full screenshot past which it is sent again. */
export const UNCHANGED_SCREENSHOT_MAX_AGE_MS = 5 * 60_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Cap on decoded scanline bytes so a malformed IHDR cannot OOM the adapter. */
const MAX_DECODED_SCANLINE_BYTES = 64 * 1024 * 1024;

interface SentScreenshot {
  id: string;
  digest: string;
  /** The tool whose result carried the full screenshot. */
  tool: string;
  sentAt: number;
  /** Notes sent in place of this screenshot since. */
  notes: number;
}

interface ScreenshotAfterAction {
  /** Present when the full image should be sent; absent when a note replaces it. */
  id?: string;
  /** Present when a note replaces the image. */
  noteText?: string;
  /** The pixels match the last full screenshot sent for the device. */
  identical: boolean;
  /** A note replaced the image. */
  note: boolean;
}

export interface ScreenshotMemory {
  /**
   * Records a full screenshot the agent received from an explicit `screenshot`
   * call. Returns the id to send with it.
   */
  sent(udid: string, png: Buffer, toolName: string): string;
  /** Decides whether an auto-screenshot should send the image or an unchanged note. */
  afterAction(udid: string, png: Buffer, toolName: string): ScreenshotAfterAction;
  /** Drops the screenshot of a device: the result that carried it did not reach the agent. */
  forget(udid: string): void;
}

/** The line that gives a full screenshot its id. */
export function screenshotIdLine(id: string): string {
  return `Screenshot id: ${id}`;
}

/** The note sent in place of an auto-screenshot whose pixels match `id`. */
export function unchangedScreenshotNote(id: string, tool: string): string {
  return `Screenshot matches \`${id}\` from an earlier \`${tool}\` result (pixels unchanged). Call \`screenshot\` if you need a fresh image.`;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function channelsForColorType(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // Grayscale
    case 2:
      return 3; // RGB
    case 4:
      return 2; // Grayscale + Alpha
    case 6:
      return 4; // RGBA
    default:
      return 0;
  }
}

/**
 * Computes a pixel-content SHA-256 fingerprint for a PNG buffer.
 *
 * Decoding 8-bit non-interlaced PNG scanlines ignores PNG metadata chunks
 * (`tIME`, `tEXt`, `pHYs`, `iCCP`) and zlib compression settings while staying
 * strictly pixel-exact (any single changed pixel produces a different digest).
 * Falls back to hashing the raw PNG bytes for indexed/16-bit/interlaced or
 * non-standard PNGs.
 */
export function fingerprintPng(png: Buffer): string {
  const pixelDigest = tryFingerprintPngPixels(png);
  if (pixelDigest !== null) return pixelDigest;
  return createHash("sha256").update("raw:").update(png).digest("hex");
}

function tryFingerprintPngPixels(png: Buffer): string | null {
  if (png.length < PNG_SIGNATURE.length + 25) return null;
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;

  let width = 0;
  let height = 0;
  let colorType = -1;
  let hasIhdr = false;
  const idatChunks: Buffer[] = [];

  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) return null;

    if (type === "IHDR") {
      if (length !== 13) return null;
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      const bitDepth = png[dataStart + 8]!;
      colorType = png[dataStart + 9]!;
      const compression = png[dataStart + 10]!;
      const filter = png[dataStart + 11]!;
      const interlace = png[dataStart + 12]!;
      if (
        width <= 0 ||
        height <= 0 ||
        bitDepth !== 8 ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        return null;
      }
      hasIhdr = true;
    } else if (type === "IDAT") {
      idatChunks.push(png.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (!hasIhdr || idatChunks.length === 0) return null;
  const bpp = channelsForColorType(colorType);
  if (bpp === 0) return null;

  const stride = width * bpp;
  const expectedBytes = height * (1 + stride);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_DECODED_SCANLINE_BYTES) {
    return null;
  }

  let inflated: Buffer;
  try {
    const compressed = idatChunks.length === 1 ? idatChunks[0]! : Buffer.concat(idatChunks);
    inflated = inflateSync(compressed, { maxOutputLength: expectedBytes });
  } catch {
    return null;
  }
  if (inflated.length !== expectedBytes) return null;

  const hash = createHash("sha256");
  hash.update(`pixels:${width}x${height}:${colorType}:`);

  let prev = new Uint8Array(stride);
  let curr = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    const filterType = inflated[rowStart]!;
    for (let x = 0; x < stride; x++) {
      const raw = inflated[rowStart + 1 + x]!;
      const a = x >= bpp ? curr[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      switch (filterType) {
        case 0:
          curr[x] = raw;
          break;
        case 1:
          curr[x] = (raw + a) & 0xff;
          break;
        case 2:
          curr[x] = (raw + b) & 0xff;
          break;
        case 3:
          curr[x] = (raw + ((a + b) >>> 1)) & 0xff;
          break;
        case 4:
          curr[x] = (raw + paeth(a, b, c)) & 0xff;
          break;
        default:
          return null;
      }
    }
    hash.update(curr);
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return hash.digest("hex");
}

function randomTag(): string {
  return randomInt(36 ** 3)
    .toString(36)
    .padStart(3, "0");
}

/**
 * One per MCP session. Holds only a 64-char hex digest per device — never the
 * raw PNG bytes.
 */
export function createScreenshotMemory(
  now: () => number = Date.now,
  tag: string = randomTag()
): ScreenshotMemory {
  const lastSent = new Map<string, SentScreenshot>();
  let count = 0;

  const record = (udid: string, digest: string, toolName: string): string => {
    const id = `${tag}-${++count}`;
    lastSent.set(udid, {
      id,
      digest,
      tool: normalizeToolName(toolName),
      sentAt: now(),
      notes: 0,
    });
    return id;
  };

  return {
    sent(udid, png, toolName) {
      return record(udid, fingerprintPng(png), toolName);
    },
    afterAction(udid, png, toolName) {
      const digest = fingerprintPng(png);
      const last = lastSent.get(udid);
      const identical = last !== undefined && last.digest === digest;
      if (
        last !== undefined &&
        identical &&
        last.notes < MAX_UNCHANGED_SCREENSHOTS_IN_A_ROW &&
        now() - last.sentAt <= UNCHANGED_SCREENSHOT_MAX_AGE_MS
      ) {
        last.notes += 1;
        return {
          noteText: unchangedScreenshotNote(last.id, last.tool),
          identical: true,
          note: true,
        };
      }
      const id = record(udid, digest, toolName);
      return { id, identical, note: false };
    },
    forget(udid) {
      lastSent.delete(udid);
    },
  };
}
