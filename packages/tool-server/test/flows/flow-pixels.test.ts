import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import type { ActionEnv } from "../../src/tools/flows/flow-actions";
import {
  __resetPixelCaptureSupportCacheForTesting,
  capturePixels,
  FIRST_PIXEL_CAPTURE_TIMEOUT_MS,
  getPixelCaptureSupport,
  PIXEL_CAPTURE_TIMEOUT_MS,
  PIXEL_SETTLE_POLL_MS,
  PIXEL_SETTLE_TIMEOUT_MS,
  PIXEL_THRESHOLD,
  pixelsDiffer,
  settlePixels,
  type PixelFrame,
} from "../../src/tools/flows/flow-pixels";
import { DEFAULT_THRESHOLD } from "../../src/tools/screenshot-diff/screenshot-diff";
import { getSimulatorRuntimeKind } from "../../src/utils/ios-devices";
import { FIRST_FRAME_WAIT_MS } from "../../src/utils/simulator-client";

vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  getSimulatorRuntimeKind: vi.fn(async () => "mobile"),
}));

let tmpDir: string;
const mockGetSimulatorRuntimeKind = vi.mocked(getSimulatorRuntimeKind);

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pixels-"));
  __resetPixelCaptureSupportCacheForTesting();
  mockGetSimulatorRuntimeKind.mockReset().mockResolvedValue("mobile");
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

/** Rewrite every pixel's alpha in place, returning the frame. */
function withAlpha(base: PixelFrame, alpha: number): PixelFrame {
  for (let i = 0; i < base.width * base.height; i++) {
    base.data[i * 4 + 3] = alpha;
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

  it.each<[string, [number, number, number]]>([
    ["red", [255, 0, 0]],
    ["green", [0, 255, 0]],
    ["blue", [0, 0, 255]],
  ])("registers a full-frame change confined to the %s channel as motion", (_channel, color) => {
    // Motion that lives in a single channel must clear the per-pixel gate on
    // that channel's term alone — the other two contribute zero, so dropping
    // any one term from the distance goes blind to exactly one of these.
    expect(pixelsDiffer(solid(30, 30, [0, 0, 0]), solid(30, 30, color))).toBe(true);
  });

  it("registers a mid-amplitude blue-only change as motion (a navy scrim fading in over black)", () => {
    // Black → navy #000080 moves only blue, and only by 128 — comfortably
    // above the ~44 per-pixel tolerance without saturating the channel. The
    // plausible real instance of single-channel motion the distance must see.
    expect(pixelsDiffer(solid(30, 30, [0, 0, 0]), solid(30, 30, [0, 0, 128]))).toBe(true);
  });

  it("ignores a change confined to the alpha channel (a screen capture is opaque)", () => {
    // Identical RGB, alpha 255 → 0 on every pixel: the docstring promises
    // alpha is ignored, so this must read as still. This also pins the byte
    // offsets — a comparator that read o+3 (alpha) where it meant o+2 (blue)
    // would count every pixel here as changed.
    expect(
      pixelsDiffer(solid(30, 30, [10, 20, 30]), withAlpha(solid(30, 30, [10, 20, 30]), 0))
    ).toBe(false);
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

  it("registers a mid-band full-frame change as motion (a dim / fade / crossfade)", () => {
    // +120 on every channel is an RGB distance of ~208 — far above the ~44
    // tolerance, yet inside the band a loosened threshold (e.g. 0.5 → ~221)
    // would swallow. A modal dim or nav-push crossfade must never read as
    // still mid-transition.
    expect(pixelsDiffer(solid(30, 30, [0, 0, 0]), solid(30, 30, [120, 120, 120]))).toBe(true);
  });

  it("brackets the per-pixel tolerance from both sides", () => {
    // The tolerance is 0.03 × ~441.7 ≈ 13.25. A uniform +7 per channel is a
    // distance of ~12.1 (just under) and +8 is ~13.9 (just over), so this pair
    // pins the constant tightly: loosening it trips the second expectation and
    // tightening it trips the first.
    expect(pixelsDiffer(solid(30, 30, [100, 100, 100]), solid(30, 30, [107, 107, 107]))).toBe(
      false
    );
    expect(pixelsDiffer(solid(30, 30, [100, 100, 100]), solid(30, 30, [108, 108, 108]))).toBe(true);
  });

  it("registers two consecutive samples of a slow uniform cross-fade as motion", () => {
    // The regression this tolerance exists at its current value for. A
    // spatially uniform fade moves every pixel by the same amount, so it
    // clears the per-pixel gate on all pixels or on none — MOTION_FRACTION is
    // never the deciding term. These are two samples ~PIXEL_SETTLE_POLL_MS
    // apart of a 2s indigo-over-white dismissal (9% of the fade), a per-channel
    // delta of (16, 23, 12) — distance ~30.5. Above the current ~13.25 gate,
    // but BELOW the ~44.2 a baseline-sized tolerance imposes, where the settle
    // counted zero pixels and reported `settled` mid-animation while the
    // overlay was still painted and still hit-testing.
    expect(pixelsDiffer(solid(30, 30, [165, 128, 193]), solid(30, 30, [149, 105, 181]))).toBe(true);
  });

  it("stays independent of, and stricter than, screenshot-diff's DEFAULT_THRESHOLD", () => {
    // The two tolerances are deliberately NOT mirrored: screenshot-diff holds
    // a baseline stored across sessions/machines against a live capture and
    // must absorb real drift, while this compares two captures from one live
    // session, where a static screen reads back byte-identical. Pin the value
    // so the gate — the whole motion oracle — cannot drift silently, and pin
    // the direction so "restoring parity" is a deliberate act that trips a
    // test rather than a quiet 3.3x widening of the cross-fade blind spot.
    expect(PIXEL_THRESHOLD).toBe(0.03);
    expect(PIXEL_THRESHOLD).toBeLessThan(DEFAULT_THRESHOLD);
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
  it("returns undefined on Vega without touching the registry (no capture backend there)", async () => {
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

  it.each([
    ["ios", "simulator"],
    ["android", "emulator"],
  ] as const)(
    "captures and cleans up decodable pixels through the native %s backend",
    async (platform, kind) => {
      const file = path.join(tmpDir, `${platform}-native.png`);
      const png = new PNG({ width: 2, height: 1 });
      png.data.set([10, 20, 30, 255, 40, 50, 60, 255]);
      await fs.writeFile(file, PNG.sync.write(png));
      const screenshot = vi.fn(async () => ({ path: file, url: `file://${file}` }));
      const device = { platform, kind, id: `${platform}-device` };
      const resolveService = vi.fn(async () => ({
        transport: { screenshot },
      }));
      const env = {
        device,
        registry: { resolveService },
      } as unknown as ActionEnv;

      const pixels = await capturePixels(env);

      expect(pixels).toMatchObject({ width: 2, height: 1 });
      expect([...pixels!.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
      expect(resolveService).toHaveBeenCalledWith(`SimulatorServer:${device.id}`, { device });
      expect(screenshot).toHaveBeenCalledWith({
        rotation: undefined,
        scale: 0.25,
        signal: undefined,
      });
      await expect(fs.access(file)).rejects.toThrow();
    }
  );

  it("still removes the simulator-server temp file when the flow aborts mid-capture", async () => {
    // The simulator-server writes its PNG to the host filesystem BEFORE it
    // replies — the {url, path} in the response names a file that already
    // exists. If env.signal were threaded into the capture fetch, an abort
    // landing in that window would reject the fetch before the path is
    // learned and orphan the file. captureFile therefore deliberately runs
    // the capture to completion; this pins that: abort while the scripted
    // server is holding its (already-written) reply, and the capture must
    // still learn the path, decode the frame, and delete the file.
    const file = path.join(tmpDir, "aborted-capture.png");
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([10, 20, 30, 255, 40, 50, 60, 255]);
    const bytes = PNG.sync.write(png);
    const controller = new AbortController();
    const server = http.createServer((req, res) => {
      res.on("error", () => {});
      void fs.writeFile(file, bytes).then(() => {
        // The file is on disk; the client is now waiting on the reply. Abort
        // the flow signal in exactly that window, then reply shortly after —
        // the same ordering the real server produces under a client cancel.
        controller.abort();
        setTimeout(() => {
          try {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ url: `file://${file}`, path: file }));
          } catch {
            // Pre-fix the aborted client has hung up; ignore the dead socket.
          }
        }, 150);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const env = {
      device: { platform: "ios", kind: "simulator", id: "00000000-0000-0000-0000-0000000000ad" },
      signal: controller.signal,
      registry: {
        resolveService: vi.fn(async () => ({ apiUrl: `http://127.0.0.1:${port}` })),
      },
    } as unknown as ActionEnv;

    try {
      const pixels = await capturePixels(env);

      expect(controller.signal.aborted).toBe(true);
      expect(pixels).toMatchObject({ width: 2, height: 1 });
      expect([...pixels!.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
      await expect(fs.access(file)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("classifies tvOS before service resolution and leaves Android TV capture-capable", async () => {
    mockGetSimulatorRuntimeKind.mockResolvedValue("tv");
    const resolveService = vi.fn(() => {
      throw new Error("simulator-server must not be resolved for tvOS");
    });
    const tvOs = {
      platform: "ios",
      kind: "simulator",
      id: "00000000-0000-0000-0000-0000000000TV",
    } as const;

    await expect(getPixelCaptureSupport(tvOs)).resolves.toBe("absent");
    await expect(
      capturePixels({ device: tvOs, registry: { resolveService } } as unknown as ActionEnv)
    ).resolves.toBeUndefined();
    expect(resolveService).not.toHaveBeenCalled();

    mockGetSimulatorRuntimeKind.mockClear();
    await expect(
      getPixelCaptureSupport({ platform: "android", kind: "emulator", id: "android-tv" })
    ).resolves.toBe("available");
    expect(mockGetSimulatorRuntimeKind).not.toHaveBeenCalled();
  });

  it("evicts an unknown iOS verdict while keeping each failed capture honest", async () => {
    mockGetSimulatorRuntimeKind.mockResolvedValue(undefined);
    const device = {
      platform: "ios",
      kind: "simulator",
      id: "00000000-0000-0000-0000-0000000000ab",
    } as const;
    const resolveService = vi.fn(() => {
      throw new Error("unknown support must not be treated as available");
    });
    const env = { device, registry: { resolveService } } as unknown as ActionEnv;

    await expect(capturePixels(env)).resolves.toBeUndefined();
    await expect(capturePixels(env)).resolves.toBeUndefined();

    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(2);
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("shares a pending unknown probe, then retries the same device and recovers to mobile", async () => {
    let resolveFirst!: (kind: "mobile" | "tv" | undefined) => void;
    const first = new Promise<"mobile" | "tv" | undefined>((resolve) => {
      resolveFirst = resolve;
    });
    mockGetSimulatorRuntimeKind.mockImplementationOnce(() => first).mockResolvedValue("mobile");
    const device = {
      platform: "ios",
      kind: "simulator",
      id: "00000000-0000-0000-0000-0000000000ac",
    } as const;

    const pendingA = getPixelCaptureSupport(device);
    const pendingB = getPixelCaptureSupport(device);
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(1);
    resolveFirst(undefined);
    await expect(Promise.all([pendingA, pendingB])).resolves.toEqual(["unknown", "unknown"]);

    await expect(getPixelCaptureSupport(device)).resolves.toBe("available");
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(2);

    const file = path.join(tmpDir, "recovered-mobile.png");
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([10, 20, 30, 255]);
    await fs.writeFile(file, PNG.sync.write(png));
    const screenshot = vi.fn(async () => ({ path: file, url: `file://${file}` }));
    const resolveService = vi.fn(async () => ({ transport: { screenshot } }));
    const env = { device, registry: { resolveService } } as unknown as ActionEnv;

    await expect(capturePixels(env)).resolves.toMatchObject({ width: 1, height: 1 });
    expect(mockGetSimulatorRuntimeKind).toHaveBeenCalledTimes(2);
    expect(resolveService).toHaveBeenCalledTimes(1);
    await expect(fs.access(file)).rejects.toThrow();
  });
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

  function simulatorEnv(captureScreenshot: () => Promise<{ path: string }>): ActionEnv {
    return {
      device: { platform: "ios", id: "00000000-0000-0000-0000-0000000000ab" },
      registry: {
        resolveService: vi.fn(async () => ({
          transport: { screenshot: captureScreenshot },
        })),
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

  it("settles a transition that comes to rest looking different from the first frame", async () => {
    // Canonical modal-dismiss / nav-push shape: the screen moves (A → B → C)
    // and then holds at C. Each capture must match against its predecessor —
    // comparing against the first frame instead would never find A again and
    // would burn the whole window into "timed-out". The caller deadline keeps
    // that failure mode fast and deterministic.
    const captureScreenshot = vi.fn(
      captureFactory([
        [0, 0, 0],
        [255, 255, 255],
        [40, 120, 200],
      ])
    );

    await expect(
      settlePixels(chromiumEnv(captureScreenshot), { absoluteDeadline: Date.now() + 2_000 })
    ).resolves.toBe("settled");
    // Exactly four captures — A, B, C, then the matching C — so the match was
    // found on the predecessor comparison, not by wandering back to frame one.
    expect(captureScreenshot).toHaveBeenCalledTimes(4);
  });

  it("shares a default window sized for first-frame and steady-state capture latency", () => {
    expect(FIRST_PIXEL_CAPTURE_TIMEOUT_MS).toBeGreaterThan(FIRST_FRAME_WAIT_MS);
    expect(PIXEL_CAPTURE_TIMEOUT_MS).toBe(2_000);
    expect(PIXEL_SETTLE_POLL_MS).toBe(150);
    expect(PIXEL_SETTLE_TIMEOUT_MS).toBe(
      FIRST_PIXEL_CAPTURE_TIMEOUT_MS + PIXEL_SETTLE_POLL_MS + PIXEL_CAPTURE_TIMEOUT_MS
    );
  });

  it("settles a first-frame-boundary capture plus completion overhead and a warm capture", async () => {
    const files = [path.join(tmpDir, "slow-0.png"), path.join(tmpDir, "slow-1.png")];
    for (const file of files) {
      const png = new PNG({ width: 2, height: 2 });
      png.data.fill(255);
      await fs.writeFile(file, PNG.sync.write(png));
    }
    vi.useFakeTimers();
    let index = 0;
    const captureScreenshot = vi.fn(async () => {
      const delay = index === 0 ? FIRST_FRAME_WAIT_MS + 250 : PIXEL_CAPTURE_TIMEOUT_MS - 100;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      return { path: files[index++]! };
    });
    const startedAt = Date.now();
    const pending = settlePixels(simulatorEnv(captureScreenshot));
    let settledAt: number | undefined;
    const measured = pending.then((outcome) => {
      settledAt = Date.now();
      return outcome;
    });

    await vi.advanceTimersByTimeAsync(FIRST_FRAME_WAIT_MS + 250);
    // Allow the real file read/decode/removal and observation gap to finish.
    await vi.waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(PIXEL_CAPTURE_TIMEOUT_MS - 100);

    await expect(measured).resolves.toBe("settled");
    expect(settledAt! - startedAt).toBeLessThan(PIXEL_SETTLE_TIMEOUT_MS);
    expect(captureScreenshot).toHaveBeenCalledTimes(2);
    await expect(Promise.all(files.map((file) => fs.access(file)))).rejects.toThrow();
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

  it("expires a hung Chromium first capture at its per-capture timeout", async () => {
    vi.useFakeTimers();
    const captureScreenshot = vi.fn(() => new Promise<{ path: string }>(() => {}));
    let outcome: Awaited<ReturnType<typeof settlePixels>> | undefined;
    const pending = settlePixels(chromiumEnv(captureScreenshot)).then((value) => {
      outcome = value;
      return value;
    });

    await vi.advanceTimersByTimeAsync(PIXEL_CAPTURE_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe("timed-out");
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
  });

  it("expires a hung subsequent capture at its own timeout", async () => {
    vi.useFakeTimers();
    const file = path.join(tmpDir, "first.png");
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(255);
    await fs.writeFile(file, PNG.sync.write(png));
    let calls = 0;
    let outcome: Awaited<ReturnType<typeof settlePixels>> | undefined;
    let settledAt = -1;
    let secondStartedAt = -1;
    const captureScreenshot = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve({ path: file });
      secondStartedAt = Date.now();
      return new Promise<{ path: string }>(() => {});
    });
    const pending = settlePixels(chromiumEnv(captureScreenshot)).then((value) => {
      outcome = value;
      settledAt = Date.now();
      return value;
    });

    await vi.waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(PIXEL_CAPTURE_TIMEOUT_MS);

    await expect(pending).resolves.toBe("timed-out");
    expect(outcome).toBe("timed-out");
    expect(settledAt - secondStartedAt).toBe(PIXEL_CAPTURE_TIMEOUT_MS);
  });

  it("reports timed-out on an already-spent caller deadline without consulting any backend", async () => {
    // The snapshot outage fallback can arrive here with nothing left: the
    // first tree settle consumed the whole action window before proving the
    // source down. The zero-budget entry deliberately collapses into
    // "timed-out" — the settle window expired before stillness was proven.
    // It must never read as "aborted" (runSnapshot would skip the step
    // blaming a cancellation that never happened) or "unavailable" (nothing
    // probed the backend), and no capture or service resolution may launch.
    const captureScreenshot = vi.fn(captureFactory([[10, 20, 30]]));
    const resolveService = vi.fn(async () => ({ captureScreenshot }));
    const env = {
      device: { platform: "chromium", id: "chromium-cdp-9222" },
      registry: { resolveService },
    } as unknown as ActionEnv;

    await expect(settlePixels(env, { absoluteDeadline: Date.now() - 1 })).resolves.toBe(
      "timed-out"
    );
    expect(resolveService).not.toHaveBeenCalled();
    expect(captureScreenshot).not.toHaveBeenCalled();
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
