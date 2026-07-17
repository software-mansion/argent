import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import type { ActionEnv } from "../../src/tools/flows/flow-actions";
import {
  capturePixels,
  pixelsDiffer,
  settlePixels,
  type PixelFrame,
} from "../../src/tools/flows/flow-pixels";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pixels-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A solid-color RGBA frame — the unit under test only compares RGB. */
function solid(width: number, height: number, [r, g, b]: [number, number, number]): PixelFrame {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Flip `count` pixels of `base` to `color`, in place, returning it. */
function withChangedPixels(base: PixelFrame, count: number, color: number): PixelFrame {
  for (let i = 0; i < count; i++) {
    base.data[i * 4] = color;
    base.data[i * 4 + 1] = color;
    base.data[i * 4 + 2] = color;
  }
  return base;
}

describe("pixelsDiffer", () => {
  it("reports no motion for two identical frames", () => {
    expect(pixelsDiffer(solid(30, 30, [10, 20, 30]), solid(30, 30, [10, 20, 30]))).toBe(false);
  });

  it("reports motion when the whole frame changes", () => {
    expect(pixelsDiffer(solid(30, 30, [0, 0, 0]), solid(30, 30, [255, 255, 255]))).toBe(true);
  });

  it("treats a dimension change as motion (a resizing/rotating surface)", () => {
    expect(pixelsDiffer(solid(30, 30, [0, 0, 0]), solid(30, 31, [0, 0, 0]))).toBe(true);
  });

  it("ignores a sub-threshold per-pixel color drift (encoder / resample noise)", () => {
    // +5 on every channel is well under the per-pixel tolerance, so no pixel
    // counts as changed — two captures of a static screen must read as still.
    expect(pixelsDiffer(solid(30, 30, [100, 100, 100]), solid(30, 30, [105, 105, 105]))).toBe(
      false
    );
  });

  it("ignores a handful of changed pixels below the motion fraction", () => {
    // 900 px, fraction 0.002 → ~1.8 px budget: one changed pixel stays "still"
    // (a blinking cursor), three tips it over into motion.
    const base = solid(30, 30, [0, 0, 0]);
    expect(pixelsDiffer(base, withChangedPixels(solid(30, 30, [0, 0, 0]), 1, 255))).toBe(false);
    expect(pixelsDiffer(base, withChangedPixels(solid(30, 30, [0, 0, 0]), 3, 255))).toBe(true);
  });
});

describe("capturePixels", () => {
  it("returns undefined on Vega without touching the registry (no touch input there)", async () => {
    let resolved = false;
    const env = {
      device: { platform: "vega", id: "vega-serial" },
      registry: {
        resolveService: () => {
          resolved = true;
          throw new Error("should not be called");
        },
      },
    } as unknown as ActionEnv;

    expect(await capturePixels(env)).toBeUndefined();
    expect(resolved).toBe(false);
  });

  it.each(["ios", "android", "chromium"] as const)(
    "returns undefined (never throws) on %s when the capture backend can't be resolved",
    async (platform) => {
      const env = {
        device: { platform, id: "some-device" },
        registry: {}, // no resolveService — resolving throws, capture soft-fails
      } as unknown as ActionEnv;

      expect(await capturePixels(env)).toBeUndefined();
    }
  );
});

describe("settlePixels", () => {
  function chromiumEnv(
    captureScreenshot: () => Promise<{ path: string }>,
    signal?: AbortSignal
  ): ActionEnv {
    return {
      device: { platform: "chromium", id: "chromium-cdp-9222" },
      signal,
      registry: {
        resolveService: vi.fn(async () => ({ captureScreenshot })),
      },
    } as unknown as ActionEnv;
  }

  function captureFactory(colors: Array<[number, number, number]>) {
    let index = 0;
    return async (): Promise<{ path: string }> => {
      const color = colors[Math.min(index, colors.length - 1)]!;
      const png = new PNG({ width: 2, height: 2 });
      for (let i = 0; i < 4; i++) {
        png.data[i * 4] = color[0];
        png.data[i * 4 + 1] = color[1];
        png.data[i * 4 + 2] = color[2];
        png.data[i * 4 + 3] = 255;
      }
      const file = path.join(tmpDir, `capture-${index++}.png`);
      await fs.writeFile(file, PNG.sync.write(png));
      return { path: file };
    };
  }

  it("reports settled after two matching captures", async () => {
    const captureScreenshot = vi.fn(captureFactory([[10, 20, 30]]));

    await expect(settlePixels(chromiumEnv(captureScreenshot))).resolves.toBe("settled");
    expect(captureScreenshot).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable when no pixel source exists", async () => {
    const env = {
      device: { platform: "vega", id: "vega-serial" },
      registry: {},
    } as unknown as ActionEnv;

    await expect(settlePixels(env)).resolves.toBe("unavailable");
  });

  it("bounds a hung capture by the pixel deadline", async () => {
    vi.useFakeTimers();
    const captureScreenshot = vi.fn(() => new Promise<{ path: string }>(() => {}));
    const pending = settlePixels(chromiumEnv(captureScreenshot), {
      absoluteDeadline: Date.now() + 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe("timed-out");
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
  });

  it("reports aborted without capturing when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const captureScreenshot = vi.fn(captureFactory([[10, 20, 30]]));

    await expect(settlePixels(chromiumEnv(captureScreenshot, controller.signal))).resolves.toBe(
      "aborted"
    );
    expect(captureScreenshot).not.toHaveBeenCalled();
  });
});
