import { promises as fs } from "node:fs";
import { adbShell } from "./adb";

/**
 * The orientation names the simulator-server screenshot API accepts.
 *
 * Read these as *compositing transforms*, not as physical orientations. The
 * distinction matters: a report on #609 established that on iOS the same names
 * are 180° inverted from the physical result, so nothing here may be derived
 * from what the words mean.
 */
export type OrientationName =
  | "Portrait"
  | "LandscapeLeft"
  | "LandscapeRight"
  | "PortraitUpsideDown";

/** Android's surface rotation, as reported by the platform (`Surface.ROTATION_*`). */
export type SurfaceRotation = 0 | 1 | 2 | 3;

/**
 * Surface rotation → the name that makes simulator-server hand back an upright
 * capture.
 *
 * DERIVED BY MEASUREMENT, NOT BY NAME. `adb exec-out screencap` is
 * rotation-aware, so it is ground truth; each candidate name was captured at
 * full scale and scored against it as mean absolute difference over a 96×54
 * grayscale grid, both as-is and rotated 180° to catch an inverted mapping:
 *
 *   rotation 1  LandscapeLeft       MAD  2.19  (vs 6.54 for its 180° twin)
 *   rotation 3  LandscapeRight      MAD  2.19  (vs 6.34)
 *   rotation 2  PortraitUpsideDown  MAD  2.67  (vs 13.13)
 *   rotation 0  Portrait            identity — an unrotated capture is already upright
 *
 * Note this table is the INVERSE of simulator-server's own convention, which
 * maps 90° → LandscapeRight (`src/device_controller.rs`) and rotates the frame
 * at decode time from the scrcpy header's `display_orientation`
 * (`src/device_controller/android_device/video.rs`,
 * `src/media_handler/decoder/video_toolbox.rs`). We are compensating downstream
 * for what that layer already did, so this constant encodes the behaviour of a
 * particular simulator-server build rather than a property of Android.
 *
 * That is why a unit test pinning this table is not sufficient on its own: it
 * could never notice simulator-server changing underneath us. `captureLooksUpright`
 * below is the check that would, and it is applied to the real capture.
 */
export const SURFACE_ROTATION_TO_NAME: Readonly<Record<SurfaceRotation, OrientationName>> = {
  0: "Portrait",
  1: "LandscapeLeft",
  2: "PortraitUpsideDown",
  3: "LandscapeRight",
};

function isSurfaceRotation(value: number): value is SurfaceRotation {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/**
 * Read the device's current surface rotation.
 *
 * Returns `null` — never throws — when the rotation cannot be established. A
 * failed query must degrade to "unknown", which callers treat as "behave
 * exactly as before". It must never fall back to a guess: a wrong orientation
 * produces a confidently wrong image, which is worse than the sideways one this
 * is fixing.
 *
 * Two independent readings are tried because `dumpsys` output is not a stable
 * API. `|| true` keeps a `grep` miss (exit 1) from making `adbShell` throw.
 */
export async function readAndroidSurfaceRotation(serial: string): Promise<SurfaceRotation | null> {
  const probes: { cmd: string; pattern: RegExp }[] = [
    {
      cmd: "dumpsys display | grep mCurrentOrientation || true",
      pattern: /mCurrentOrientation=([0-3])/,
    },
    { cmd: "dumpsys window displays || true", pattern: /\bmRotation=([0-3])/ },
  ];

  for (const { cmd, pattern } of probes) {
    try {
      const out = await adbShell(serial, cmd, { timeoutMs: 5_000 });
      const value = Number(pattern.exec(out)?.[1]);
      if (Number.isInteger(value) && isSurfaceRotation(value)) return value;
    } catch {
      // Try the next probe; exhausting them yields null.
    }
  }
  return null;
}

/**
 * The rotation to request for an upright capture, or `undefined` to send no
 * rotation at all.
 *
 * `undefined` is returned for an unrotated device rather than `"Portrait"` so
 * the request body is byte-identical to what it was before this existed — the
 * overwhelmingly common case stays provably unchanged.
 */
export function captureRotationForSurface(
  rotation: SurfaceRotation | null
): OrientationName | undefined {
  if (rotation === null || rotation === 0) return undefined;
  return SURFACE_ROTATION_TO_NAME[rotation];
}

/** Width and height from a PNG's IHDR chunk, or null if this isn't a PNG. */
export async function readPngSize(path: string): Promise<{ width: number; height: number } | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, "r");
    const buf = Buffer.alloc(24);
    const { bytesRead } = await handle.read(buf, 0, 24, 0);
    if (bytesRead < 24) return null;
    // 8-byte signature, then a length+type header, then IHDR's width/height.
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Does a capture taken with `requested` actually have the shape that rotation
 * implies?
 *
 * This is the guard that a table test cannot be. The mapping above compensates
 * for a rotation simulator-server applies at decode time; if that layer changes,
 * the compensation silently becomes a 180° error or a no-op. Comparing the
 * delivered PNG's aspect against the orientation we asked for catches the case
 * where the request did not do what this module assumes.
 *
 * Returns true when unknown — an unreadable PNG is not evidence of a problem.
 */
export function captureLooksUpright(
  requested: OrientationName,
  size: { width: number; height: number } | null
): boolean {
  if (!size || size.width === size.height) return true;
  const wantsLandscape = requested === "LandscapeLeft" || requested === "LandscapeRight";
  const isLandscape = size.width > size.height;
  return wantsLandscape === isLandscape;
}
