import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeviceInfo } from "@argent/registry";

/**
 * Issue #609: the capture is the surface that has to move, not the coordinates.
 * On Android `describe` frames and gesture input are already upright, so the
 * capture is made to follow the device rotation to match them. iOS is left
 * alone: there the whole surface is consistently portrait-native, and rotating
 * only the capture would break an agreement rather than restore one.
 */

const readAndroidSurfaceRotation = vi.hoisted(() =>
  vi.fn(async (_serial: string): Promise<0 | 1 | 2 | 3 | null> => null)
);
const readPngSize = vi.hoisted(() =>
  vi.fn(async (_p: string): Promise<{ width: number; height: number } | null> => null)
);

vi.mock("../src/utils/device-orientation", async (importOriginal) => {
  // The mapping table and the aspect guard stay REAL so the assertions below
  // exercise the actual constant rather than a restatement of it.
  const actual = await importOriginal<typeof import("../src/utils/device-orientation")>();
  return { ...actual, readAndroidSurfaceRotation, readPngSize };
});

import { captureScreenshotUpright } from "../src/utils/rotation-aware-capture";

const ANDROID: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
const IOS: DeviceInfo = { id: "BC0026C7-AAE0-490E", platform: "ios", kind: "simulator" };

const api = {} as never;

/** Records the rotation each capture was asked for. */
function recorder(size: { width: number; height: number } = { width: 2424, height: 1080 }) {
  const rotations: (string | undefined)[] = [];
  const capture = vi.fn(async (_api: unknown, rotation?: string) => {
    rotations.push(rotation);
    return { url: "http://x/y.png", path: "/tmp/y.png" };
  });
  readPngSize.mockResolvedValue(size);
  return { rotations, capture: capture as never };
}

beforeEach(() => {
  vi.clearAllMocks();
  readAndroidSurfaceRotation.mockResolvedValue(null);
  readPngSize.mockResolvedValue(null);
});

describe("Android capture follows the device rotation", () => {
  it("requests the matching rotation for a landscape device", async () => {
    readAndroidSurfaceRotation.mockResolvedValue(1);
    const { rotations, capture } = recorder();

    await captureScreenshotUpright(api, ANDROID, undefined, undefined, undefined, capture);

    expect(rotations).toEqual(["LandscapeLeft"]);
  });

  it("sends no rotation for an unrotated device", async () => {
    // The overwhelmingly common case must produce the exact request it always
    // did — not `rotation: "Portrait"`.
    readAndroidSurfaceRotation.mockResolvedValue(0);
    const { rotations, capture } = recorder({ width: 1080, height: 2424 });

    await captureScreenshotUpright(api, ANDROID, undefined, undefined, undefined, capture);

    expect(rotations).toEqual([undefined]);
  });

  it("sends no rotation when the device would not say", async () => {
    readAndroidSurfaceRotation.mockResolvedValue(null);
    const { rotations, capture } = recorder({ width: 1080, height: 2424 });

    await captureScreenshotUpright(api, ANDROID, undefined, undefined, undefined, capture);

    expect(rotations).toEqual([undefined]);
  });

  it("lets an explicit rotation win, and does not probe at all", async () => {
    const { rotations, capture } = recorder();

    await captureScreenshotUpright(
      api,
      ANDROID,
      "PortraitUpsideDown",
      undefined,
      undefined,
      capture
    );

    expect(rotations).toEqual(["PortraitUpsideDown"]);
    expect(readAndroidSurfaceRotation).not.toHaveBeenCalled();
  });

  it("passes the scale through unchanged", async () => {
    readAndroidSurfaceRotation.mockResolvedValue(1);
    const { capture } = recorder();

    await captureScreenshotUpright(api, ANDROID, undefined, undefined, 1.0, capture);

    expect(capture).toHaveBeenCalledWith(api, "LandscapeLeft", undefined, 1.0);
  });
});

describe("iOS is deliberately untouched", () => {
  it("never probes and never adds a rotation", async () => {
    const { rotations, capture } = recorder();

    await captureScreenshotUpright(api, IOS, undefined, undefined, undefined, capture);

    expect(rotations).toEqual([undefined]);
    expect(readAndroidSurfaceRotation).not.toHaveBeenCalled();
  });
});

describe("the aspect guard", () => {
  it("falls back to an unrotated capture when the image comes back the wrong shape", async () => {
    // Simulates simulator-server's rotation handling changing underneath us: we
    // ask for landscape and get a portrait-shaped PNG. Shipping that would be a
    // confidently wrong image, so the unrotated capture is preferred.
    readAndroidSurfaceRotation.mockResolvedValue(1);
    const { rotations, capture } = recorder({ width: 1080, height: 2424 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await captureScreenshotUpright(api, ANDROID, undefined, undefined, undefined, capture);

    expect(rotations).toEqual(["LandscapeLeft", undefined]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not second-guess a capture whose size cannot be read", async () => {
    readAndroidSurfaceRotation.mockResolvedValue(1);
    const { rotations, capture } = recorder();
    readPngSize.mockResolvedValue(null);

    await captureScreenshotUpright(api, ANDROID, undefined, undefined, undefined, capture);

    expect(rotations).toEqual(["LandscapeLeft"]);
  });
});
