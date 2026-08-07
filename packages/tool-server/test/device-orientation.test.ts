import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Issue #609: on a rotated Android device the screenshot came back
 * portrait-framed with the content lying sideways, while `describe` frames and
 * gesture coordinates were already upright. The capture was the one surface out
 * of step.
 *
 * The rotation is queried per capture rather than tracked, so these tests are
 * about reading it honestly and — crucially — about refusing to guess when it
 * cannot be read. A wrong orientation yields a confidently wrong image, which is
 * worse than the sideways one being fixed.
 */

const adbShell = vi.hoisted(() => vi.fn(async (_serial: string, _cmd: string) => ""));
vi.mock("../src/utils/adb", () => ({ adbShell }));

import {
  SURFACE_ROTATION_TO_NAME,
  captureLooksUpright,
  captureRotationForSurface,
  readAndroidSurfaceRotation,
  readPngSize,
} from "../src/utils/device-orientation";

/** Verbatim shape of the two probes, captured from a Pixel_9 (API 36). */
const DUMPSYS_DISPLAY = (r: number) => `  mCurrentOrientation=${r}\n`;
const DUMPSYS_WINDOW = (r: number) =>
  `Display: mDisplayId=0\n  init=1080x2424 420dpi\n  mRotation=${r}\n  mCurrentRotation=ROTATION_90\n`;

beforeEach(() => {
  vi.clearAllMocks();
  adbShell.mockResolvedValue("");
});

describe("the surface-rotation → rotation-name table", () => {
  // Pinned by measurement against `adb exec-out screencap`, which IS
  // rotation-aware: each candidate name was scored as mean absolute difference
  // against the screencap reference and against that reference rotated 180°, so
  // an inverted mapping could not pass. The correct name won by ~3x in every row
  // (e.g. rotation 1: LandscapeLeft 2.19 vs LandscapeRight 6.54).
  //
  // This table is the INVERSE of simulator-server's own 90°→LandscapeRight
  // convention because we are compensating for a rotation it applies while
  // decoding. That is exactly why this test cannot be the only guard — see
  // `captureLooksUpright`, which checks the real capture instead.
  it("maps each rotation to the name that yields an upright capture", () => {
    expect(SURFACE_ROTATION_TO_NAME).toEqual({
      0: "Portrait",
      1: "LandscapeLeft",
      2: "PortraitUpsideDown",
      3: "LandscapeRight",
    });
  });

  it("sends no rotation at all for an unrotated device", () => {
    // Not "Portrait": keeping it undefined leaves the request body byte-identical
    // to what it was before any of this existed, so the common case is provably
    // unchanged.
    expect(captureRotationForSurface(0)).toBeUndefined();
  });

  it("sends no rotation when the rotation could not be read", () => {
    expect(captureRotationForSurface(null)).toBeUndefined();
  });

  it("requests a rotation for each side the device can be on", () => {
    expect(captureRotationForSurface(1)).toBe("LandscapeLeft");
    expect(captureRotationForSurface(2)).toBe("PortraitUpsideDown");
    expect(captureRotationForSurface(3)).toBe("LandscapeRight");
  });
});

describe("reading the rotation off the device", () => {
  it("reads the primary probe", async () => {
    adbShell.mockResolvedValueOnce(DUMPSYS_DISPLAY(1));
    expect(await readAndroidSurfaceRotation("emulator-5554")).toBe(1);
    expect(adbShell).toHaveBeenCalledTimes(1);
  });

  it("reads every rotation the platform can report", async () => {
    for (const r of [0, 1, 2, 3]) {
      adbShell.mockResolvedValueOnce(DUMPSYS_DISPLAY(r));
      expect(await readAndroidSurfaceRotation("emulator-5554")).toBe(r);
    }
  });

  it("falls back to the second probe when the first says nothing", async () => {
    // `dumpsys` output is not a stable API, so a single regex is a single point
    // of failure across vendors and versions.
    adbShell.mockResolvedValueOnce("").mockResolvedValueOnce(DUMPSYS_WINDOW(3));
    expect(await readAndroidSurfaceRotation("emulator-5554")).toBe(3);
    expect(adbShell).toHaveBeenCalledTimes(2);
  });

  it("keeps a grep miss from throwing", async () => {
    // The probe appends `|| true` precisely so that grep exiting 1 — the normal
    // outcome when the line is absent — is not an error.
    expect(adbShell.mock.calls).toHaveLength(0);
    await readAndroidSurfaceRotation("emulator-5554");
    for (const [, cmd] of adbShell.mock.calls) expect(cmd).toContain("|| true");
  });

  it("returns null rather than guessing when both probes fail", async () => {
    adbShell.mockRejectedValue(new Error("device offline"));
    expect(await readAndroidSurfaceRotation("emulator-5554")).toBeNull();
  });

  it("returns null on unparseable output", async () => {
    adbShell.mockResolvedValue("mCurrentOrientation=banana");
    expect(await readAndroidSurfaceRotation("emulator-5554")).toBeNull();
  });

  it("ignores an out-of-range rotation", async () => {
    // Never coerce something unrecognised into a rotation — a wrong one is worse
    // than none.
    adbShell.mockResolvedValue("mCurrentOrientation=7");
    expect(await readAndroidSurfaceRotation("emulator-5554")).toBeNull();
  });
});

describe("the aspect guard on the delivered capture", () => {
  // The mapping compensates for what simulator-server does at decode time. If
  // that changes, the compensation silently becomes a 180° error or a no-op and
  // no test of our own constant could see it. This checks the actual image.
  it("accepts a landscape image for a landscape rotation", () => {
    expect(captureLooksUpright("LandscapeLeft", { width: 2424, height: 1080 })).toBe(true);
    expect(captureLooksUpright("LandscapeRight", { width: 2424, height: 1080 })).toBe(true);
  });

  it("rejects a portrait image delivered for a landscape rotation", () => {
    expect(captureLooksUpright("LandscapeLeft", { width: 1080, height: 2424 })).toBe(false);
  });

  it("accepts a portrait image for an upside-down portrait rotation", () => {
    expect(captureLooksUpright("PortraitUpsideDown", { width: 1080, height: 2424 })).toBe(true);
  });

  it("does not treat an unreadable image as evidence of a problem", () => {
    expect(captureLooksUpright("LandscapeLeft", null)).toBe(true);
  });

  it("passes a square image, which carries no aspect information", () => {
    expect(captureLooksUpright("LandscapeLeft", { width: 512, height: 512 })).toBe(true);
  });
});

describe("readPngSize", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-png-size-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A minimal valid PNG header — signature, then IHDR length/type/w/h. */
  function pngHeader(width: number, height: number): Buffer {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(0x89504e47, 0);
    buf.writeUInt32BE(0x0d0a1a0a, 4);
    buf.writeUInt32BE(13, 8);
    buf.write("IHDR", 12, "ascii");
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf;
  }

  it("reads the dimensions out of the IHDR chunk", async () => {
    const file = path.join(dir, "a.png");
    await fs.writeFile(file, pngHeader(2424, 1080));
    expect(await readPngSize(file)).toEqual({ width: 2424, height: 1080 });
  });

  it("returns null for a file that is not a PNG", async () => {
    const file = path.join(dir, "b.png");
    await fs.writeFile(file, Buffer.alloc(24));
    expect(await readPngSize(file)).toBeNull();
  });

  it("returns null for a truncated file rather than throwing", async () => {
    const file = path.join(dir, "c.png");
    await fs.writeFile(file, Buffer.alloc(8));
    expect(await readPngSize(file)).toBeNull();
  });

  it("returns null for a missing file rather than throwing", async () => {
    expect(await readPngSize(path.join(dir, "nope.png"))).toBeNull();
  });
});
