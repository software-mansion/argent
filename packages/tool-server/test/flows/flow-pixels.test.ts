import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import type { DeviceInfo } from "@argent/registry";
import type { ActionEnv } from "../../src/tools/flows/flow-actions";
import {
  capturePixelsWithin,
  FIRST_PIXEL_CAPTURE_TIMEOUT_MS,
  PIXEL_CAPTURE_TIMEOUT_MS,
  PIXEL_THRESHOLD,
  comparePixels,
  pixelCaptureTimeoutMs,
  statusBarMaskFraction,
  type PixelFrame,
} from "../../src/tools/flows/flow-pixels";
import { isTvOsSimulator } from "../../src/utils/ios-devices";
import { captureVegaScreenshotPng } from "../../src/utils/vega-screen";
import { tvScreenshot } from "../../src/tools/screenshot";
import { FIRST_FRAME_WAIT_MS } from "../../src/utils/simulator-client";

// The capture backends shell out to xcrun / adb / a live simulator-server, so
// stub the four routes and assert which one a device is sent down.
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));
vi.mock("../../src/utils/vega-screen", () => ({
  captureVegaScreenshotPng: vi.fn(),
}));
vi.mock("../../src/tools/screenshot", () => ({ tvScreenshot: vi.fn() }));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pixels-"));
  vi.mocked(isTvOsSimulator).mockReset().mockResolvedValue(false);
  vi.mocked(captureVegaScreenshotPng).mockReset();
  vi.mocked(tvScreenshot).mockReset();
});

afterEach(async () => {
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

describe("comparePixels", () => {
  it("reports no motion for two identical frames", () => {
    expect(comparePixels(solid(30, 30, [10, 20, 30]), solid(30, 30, [10, 20, 30]))).toBe("still");
  });

  it("reports motion when the whole frame changes", () => {
    expect(comparePixels(solid(30, 30, [0, 0, 0]), solid(30, 30, [255, 255, 255]))).toBe("moving");
  });

  it.each<[string, [number, number, number]]>([
    ["red", [255, 0, 0]],
    ["green", [0, 255, 0]],
    ["blue", [0, 0, 255]],
  ])("registers a full-frame change confined to the %s channel as motion", (_channel, color) => {
    // Motion that lives in a single channel must clear the per-pixel gate on
    // that channel's term alone — the other two contribute zero, so dropping
    // any one term from the distance goes blind to exactly one of these.
    expect(comparePixels(solid(30, 30, [0, 0, 0]), solid(30, 30, color))).toBe("moving");
  });

  it("ignores a change confined to the alpha channel (a screen capture is opaque)", () => {
    // Identical RGB, alpha 255 → 0 on every pixel: the docstring promises alpha
    // is ignored, so this must read as still. This also pins the byte offsets —
    // a comparator that read o+3 (alpha) where it meant o+2 (blue) would count
    // every pixel here as changed.
    expect(
      comparePixels(solid(30, 30, [10, 20, 30]), withAlpha(solid(30, 30, [10, 20, 30]), 0))
    ).toBe("still");
  });

  it("treats a dimension change as motion (a resized window)", () => {
    expect(comparePixels(solid(30, 30, [0, 0, 0]), solid(30, 31, [0, 0, 0]))).toBe("moving");
  });

  it("ignores a sub-threshold per-pixel color drift (encoder / resample noise)", () => {
    // +5 on every channel is well under the per-pixel tolerance, so no pixel
    // counts as changed — two captures of a static screen must read as still.
    expect(comparePixels(solid(30, 30, [100, 100, 100]), solid(30, 30, [105, 105, 105]))).toBe(
      "still"
    );
  });

  it("brackets the per-pixel tolerance from both sides", () => {
    // The tolerance is 0.03 x ~441.7 ~= 13.25. A uniform +7 per channel is a
    // distance of ~12.1 (just under) and +8 is ~13.9 (just over), so this pair
    // pins the constant tightly: loosening it trips the second expectation and
    // tightening it trips the first.
    expect(comparePixels(solid(30, 30, [100, 100, 100]), solid(30, 30, [107, 107, 107]))).toBe(
      "still"
    );
    expect(comparePixels(solid(30, 30, [100, 100, 100]), solid(30, 30, [108, 108, 108]))).toBe(
      "moving"
    );
  });

  it("registers two consecutive samples of a slow uniform cross-fade as motion", () => {
    // The case this tolerance sits at its current value for. A spatially
    // uniform fade moves every pixel by the same amount, so it clears the
    // per-pixel gate on all pixels or on none — the motion fraction is never
    // the deciding term. These are two samples one poll apart of a 2s
    // indigo-over-white dismissal, a per-channel delta of (16, 23, 12) —
    // distance ~30.5. Above the current ~13.25 gate, but BELOW the ~44.2 that
    // screenshot-diff's baseline-sized 0.1 imposes, where the settle would
    // count zero pixels and report stillness while the overlay was still
    // painted and still hit-testing.
    expect(comparePixels(solid(30, 30, [165, 128, 193]), solid(30, 30, [149, 105, 181]))).toBe(
      "moving"
    );
  });

  it("keeps its tolerance pinned, and stricter than a stored-baseline one", () => {
    // Pin the value so the gate — the whole motion oracle — cannot drift
    // silently, and so "restore parity with screenshot-diff" (0.1) is a
    // deliberate act that trips a test rather than a quiet 3.3x widening of
    // the cross-fade blind spot the case above measures.
    expect(PIXEL_THRESHOLD).toBe(0.03);
  });

  it("ignores a handful of changed pixels below the motion fraction", () => {
    // 900 px, fraction 0.002 → ~1.8 px budget: one changed pixel is not the
    // screen moving, three is.
    const base = solid(30, 30, [0, 0, 0]);
    expect(comparePixels(base, withChangedPixels(solid(30, 30, [0, 0, 0]), 1, 255))).not.toBe(
      "moving"
    );
    expect(comparePixels(base, withChangedPixels(solid(30, 30, [0, 0, 0]), 3, 255))).toBe("moving");
  });

  // Every case above runs on a 30x30 frame, where the motion budget is 1.8
  // pixels and anything visible trips it. A real capture at CAPTURE_SCALE is
  // 158k-198k pixels, and at that size the small-but-permanent movers a
  // readiness check exists to notice — a spinner above all — sit two orders of
  // magnitude below the same fraction. Measured on real captures taken at the
  // scale the check uses: a stock spinner moved 66 pixels of an iPhone 16 Pro
  // frame (302x656) and 57 of a Pixel 5 one (270x585).
  describe("at a real capture size", () => {
    const IPHONE = [302, 656] as const; // 198k px: 396 px of motion budget
    const PIXEL5 = [270, 585] as const; // 158k px: 316 px of motion budget

    function changed([w, h]: readonly [number, number], count: number): [PixelFrame, PixelFrame] {
      return [
        solid(w, h, [255, 255, 255]),
        withChangedPixels(solid(w, h, [255, 255, 255]), count, 0),
      ];
    }

    it.each([
      ["iPhone 16 Pro", IPHONE, 66],
      ["Pixel 5", PIXEL5, 57],
    ] as const)("sees a spinner on a %s frame", (_device, size, spinnerPixels) => {
      // Under the motion fraction, so the screen is not called unsettled — but
      // never "still", which is what let a still-loading screen report ready
      // with nothing said about it.
      expect(comparePixels(...changed(size, spinnerPixels))).toBe("localized");
    });

    it("still calls a real transition motion at that size", () => {
      // 1% of the frame — a sheet edge, a scrolling row, a moving cursor bar.
      expect(comparePixels(...changed(IPHONE, Math.round(IPHONE[0] * IPHONE[1] * 0.01)))).toBe(
        "moving"
      );
    });

    it("keeps a few stray pixels below even the localized floor", () => {
      // The floor exists so a backend that is not bit-exact between two
      // captures of a static screen does not warn on every settle. Three
      // pixels of 198k is an order of magnitude under a caret.
      expect(comparePixels(...changed(IPHONE, 3))).toBe("still");
    });

    // The two frames below are the ones the runner was actually caught
    // comparing on a static iPhone 16 Pro screen: the run-level status-bar pin
    // lands a few hundred milliseconds AFTER the run starts, so frame A holds
    // the real clock and frame B the pinned one. Both changes sit inside the
    // top band, which is why masking it is what fixes them.
    describe("with the status bar masked", () => {
      const MASK = 0.06;

      /** Change `count` pixels confined to rows [top, bottom] of an iPhone frame. */
      function changedInRows(count: number, top: number): [PixelFrame, PixelFrame] {
        const before = solid(IPHONE[0], IPHONE[1], [255, 255, 255]);
        const after = solid(IPHONE[0], IPHONE[1], [255, 255, 255]);
        for (let i = 0; i < count; i++) {
          const o = (top * IPHONE[0] + i) * 4;
          after.data[o] = 0;
          after.data[o + 1] = 0;
          after.data[o + 2] = 0;
        }
        return [before, after];
      }

      it("stops the pin's own clock repaint from reading as a moving screen", () => {
        // 408 changed pixels at y[19..29] — over the 396-pixel motion budget,
        // so unmasked this static screen was judged to be in motion.
        const frames = changedInRows(408, 19);
        expect(comparePixels(...frames)).toBe("moving");
        expect(comparePixels(...frames, MASK)).toBe("still");
      });

      it("stops the pin's battery-fill tail from reading as a spinner", () => {
        // The same repaint a moment later: 13 pixels at y[19..25], which is
        // over the localized floor and became "a spinner, a caret, a progress
        // dot ... the screen had not finished loading" on a loaded screen.
        const frames = changedInRows(13, 19);
        expect(comparePixels(...frames)).toBe("localized");
        expect(comparePixels(...frames, MASK)).toBe("still");
      });

      it("still sees a spinner just below the masked band", () => {
        // The mask must cost the check only the system's own band. 39 rows of
        // 656 are masked, so a spinner at row 40 is still fully visible.
        expect(comparePixels(...changedInRows(66, 40), MASK)).toBe("localized");
      });

      it("still sees a transition below the masked band", () => {
        const frames = changedInRows(0, 0);
        for (let i = 0; i < Math.round(IPHONE[0] * IPHONE[1] * 0.01); i++) {
          const o = (39 * IPHONE[0] + i) * 4;
          frames[1].data[o] = 0;
          frames[1].data[o + 1] = 0;
          frames[1].data[o + 2] = 0;
        }
        expect(comparePixels(...frames, MASK)).toBe("moving");
      });

      it("takes its fractions against the unmasked area, not the whole frame", () => {
        // 1% of the REMAINING rows must still read as motion; measuring against
        // the full frame would quietly raise every threshold by the mask.
        const visible = IPHONE[0] * (IPHONE[1] - 39);
        expect(comparePixels(...changedInRows(Math.round(visible * 0.0025), 39), MASK)).toBe(
          "moving"
        );
      });
    });
  });
});

describe("statusBarMaskFraction", () => {
  // Only iOS and Android paint a status bar into the capture. Masking a
  // Chromium window's top band would hide page content, and Vega / tvOS render
  // full-screen with no system chrome at all.
  it("masks the band on Android", async () => {
    await expect(
      statusBarMaskFraction({ platform: "android", kind: "emulator", id: "emulator-5554" })
    ).resolves.toBe(0.06);
  });

  it("masks the band on an iOS simulator", async () => {
    vi.mocked(isTvOsSimulator).mockResolvedValue(false);
    await expect(
      statusBarMaskFraction({ platform: "ios", kind: "simulator", id: "ios-udid" })
    ).resolves.toBe(0.06);
  });

  it("masks nothing on a tvOS simulator, which shares the iOS platform tag", async () => {
    vi.mocked(isTvOsSimulator).mockResolvedValue(true);
    await expect(
      statusBarMaskFraction({ platform: "ios", kind: "simulator", id: "tv-udid" })
    ).resolves.toBe(0);
  });

  it.each(["chromium", "vega"] as const)("masks nothing on %s", async (platform) => {
    await expect(
      statusBarMaskFraction({ platform, kind: "unknown", id: "some-device" })
    ).resolves.toBe(0);
    expect(isTvOsSimulator).not.toHaveBeenCalled();
  });
});

/** Write a decodable 2x1 PNG and return its path. */
async function pngAt(dir: string, name: string): Promise<string> {
  const file = path.join(dir, name);
  const png = new PNG({ width: 2, height: 1 });
  png.data.set([10, 20, 30, 255, 40, 50, 60, 255]);
  await fs.writeFile(file, PNG.sync.write(png));
  return file;
}

function envFor(device: DeviceInfo, resolveService?: unknown): ActionEnv {
  return { device, registry: { resolveService } } as unknown as ActionEnv;
}

/** The production call path, with a deadline generous enough to stay out of the way. */
function capture(env: ActionEnv): Promise<PixelFrame | undefined> {
  return capturePixelsWithin(env, Date.now() + 30_000, false);
}

/** What the fake page below paints inside the rendered window. */
const VISIBLE_BAND_RGB: [number, number, number] = [200, 30, 10];
/** What Chrome hands back for a clip rectangle outside the rendered window. */
const OFF_SCREEN_RGB: [number, number, number] = [255, 255, 255];

/** The RGB triple of one pixel of a decoded frame. */
function pixelAt(frame: PixelFrame | undefined, index: number): [number, number, number] {
  if (!frame) throw new Error("expected a decoded frame");
  const o = index * 4;
  return [frame.data[o], frame.data[o + 1], frame.data[o + 2]];
}

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/**
 * A Chromium page that answers `Page.captureScreenshot` the way the compositor
 * does: `clip` is in DOCUMENT coordinates, and with `captureBeyondViewport`
 * false only the rendered window has pixels — a rectangle outside it comes back
 * blank white. That is what makes a wrong clip origin visible as a colour here
 * rather than only as an argument.
 */
function fakeChromiumPage(opts: { metricsError?: Error } = {}): {
  api: unknown;
  scrollTo(y: number): void;
  lastClip(): Clip | undefined;
} {
  const viewport = { width: 900, height: 700, devicePixelRatio: 2 };
  let scrollY = 0;
  let lastClip: Clip | undefined;

  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getLayoutMetrics") {
      if (opts.metricsError) throw opts.metricsError;
      return {
        cssVisualViewport: {
          pageX: 0,
          pageY: scrollY,
          clientWidth: viewport.width,
          clientHeight: viewport.height,
        },
      };
    }
    if (method !== "Page.captureScreenshot") throw new Error(`unexpected CDP call ${method}`);
    lastClip = params?.clip as Clip;
    const insideWindow =
      lastClip !== undefined &&
      lastClip.y >= scrollY &&
      lastClip.y + lastClip.height <= scrollY + viewport.height;
    const [r, g, b] = insideWindow ? VISIBLE_BAND_RGB : OFF_SCREEN_RGB;
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([r, g, b, 255, r, g, b, 255]);
    return { data: PNG.sync.write(png).toString("base64") };
  });

  return {
    api: {
      cdp: { send },
      getViewport: () => viewport,
      // The route that WOULD go through sharp. Reaching for it is the bug.
      captureScreenshot: vi.fn(() => {
        throw new Error("the sharp-backed capture must not be used for a settle");
      }),
    },
    scrollTo(y: number) {
      scrollY = y;
    },
    lastClip: () => lastClip,
  };
}

describe("capturePixels routing", () => {
  // Every platform argent can screenshot has a route here, and each one is a
  // different backend — sending a device down the wrong one silently costs the
  // settle its visual half, which then degrades to a tree-only pass.
  it("captures and cleans up decodable pixels through the simulator-server backend", async () => {
    const file = await pngAt(tmpDir, "native.png");
    const screenshot = vi.fn(async () => ({ path: file, url: `file://${file}` }));
    const device: DeviceInfo = { platform: "ios", kind: "simulator", id: "ios-device" };
    const resolveService = vi.fn(async () => ({ transport: { screenshot } }));

    const pixels = await capture(envFor(device, resolveService));

    expect(pixels).toMatchObject({ width: 2, height: 1 });
    expect([...pixels!.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(resolveService).toHaveBeenCalledWith(`SimulatorServer:${device.id}`, { device });
    expect(screenshot).toHaveBeenCalledWith({
      rotation: undefined,
      scale: 0.25,
      signal: undefined,
    });
    // The temp PNG is scratch, never an artifact — it must not outlive the decode.
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("routes a tvOS simulator to xcrun, not to the simulator-server it has no backend for", async () => {
    vi.mocked(isTvOsSimulator).mockResolvedValue(true);
    vi.mocked(tvScreenshot).mockImplementation(async () => pngAt(tmpDir, "tv.png"));
    const resolveService = vi.fn(() => {
      throw new Error("simulator-server must not be resolved for tvOS");
    });
    // A tvOS simulator's platform is "ios" — only the runtime tells them apart.
    const device: DeviceInfo = { platform: "ios", kind: "simulator", id: "tv-udid" };

    await expect(capture(envFor(device, resolveService))).resolves.toMatchObject({
      width: 2,
      height: 1,
    });
    expect(tvScreenshot).toHaveBeenCalledWith("tv-udid", 0.25, expect.any(AbortSignal));
    expect(resolveService).not.toHaveBeenCalled();
  });

  // `tvScreenshot` forwards its signal to `execFileAsync`. Without one, a
  // wedged `xcrun simctl io screenshot` is never killed and the next poll
  // 200ms later spawns another, so one stuck subprocess becomes a pile of
  // them — the round abandons the promise, but nothing abandons the process.
  it("kills a wedged tvOS capture when its budget runs out", async () => {
    vi.mocked(isTvOsSimulator).mockResolvedValue(true);
    let signal: AbortSignal | undefined;
    vi.mocked(tvScreenshot).mockImplementation(
      (_udid, _scale, sig) =>
        new Promise<string>((_resolve, reject) => {
          signal = sig;
          sig?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const env = envFor({ platform: "ios", kind: "simulator", id: "tv-udid" });

    expect(await capturePixelsWithin(env, Date.now() + 50, false)).toBeUndefined();
    // The budget bounds the round and the subprocess with the same deadline,
    // so which of the two timers lands first is not fixed — only that the
    // capture does not outlive the round it belonged to.
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("kills a tvOS capture when the run itself is cancelled", async () => {
    vi.mocked(isTvOsSimulator).mockResolvedValue(true);
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    vi.mocked(tvScreenshot).mockImplementation(
      (_udid, _scale, sig) =>
        new Promise<string>((_resolve, reject) => {
          signal = sig;
          sig?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const env = { ...envFor({ platform: "ios", kind: "simulator", id: "tv-udid" }) } as ActionEnv;
    (env as { signal?: AbortSignal }).signal = controller.signal;

    const pending = capturePixelsWithin(env, Date.now() + 30_000, false);
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();

    expect(await pending).toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it("routes Vega to the emulator console, and never probes the iOS runtime for it", async () => {
    vi.mocked(captureVegaScreenshotPng).mockImplementation(async () => pngAt(tmpDir, "vega.png"));
    const resolveService = vi.fn(() => {
      throw new Error("simulator-server must not be resolved for vega");
    });

    await expect(
      capture(envFor({ platform: "vega", kind: "vvd", id: "vega-serial" }, resolveService))
    ).resolves.toMatchObject({ width: 2, height: 1 });
    expect(captureVegaScreenshotPng).toHaveBeenCalledWith({ scale: 0.25 });
    expect(isTvOsSimulator).not.toHaveBeenCalled();
    expect(resolveService).not.toHaveBeenCalled();
  });

  // Chromium is the one route that never touches the filesystem, and the one
  // that cannot use the `screenshot` tool's scaling: that resizes with `sharp`,
  // an optional dependency nothing here installs, so asking it for a quarter
  // scale returned a full-resolution PNG and a settle decoded a 23MB buffer
  // twice a second. The compositor applies `clip.scale` while rasterizing, so
  // the small frame is the only one that exists.
  it("captures Chromium through the compositor's own scale, and never via a file", async () => {
    const device: DeviceInfo = { platform: "chromium", kind: "app", id: "chromium-cdp-9222" };
    const page = fakeChromiumPage();
    const resolveService = vi.fn(async () => page.api);

    const pixels = await capture(envFor(device, resolveService));

    expect(pixels).toMatchObject({ width: 2, height: 1 });
    expect(resolveService).toHaveBeenCalledWith(`ChromiumCdp:${device.id}`, { device });
    // The clip is the viewport in CSS pixels; its scale composes with the
    // page's device scale factor, so the plain capture scale lands on a quarter
    // of the frame this route used to return.
    expect(page.lastClip()).toMatchObject({ width: 900, height: 700, scale: 0.25 });
  });

  // `clip` is measured from the top of the DOCUMENT. Pinning its origin at
  // (0, 0) therefore aimed the capture at the top of the page rather than at
  // the window, and on a scrolled document Chrome rasterizes that off-screen
  // rectangle as blank white. Two blank captures compare as identical, so the
  // pixel half of the settle voted "still" on every interval of a visibly
  // animating screen — and voted it silently, because the capture succeeded.
  //
  // The mock below is the compositor's actual behaviour rather than an
  // argument matcher: it serves whatever the clip rectangle overlaps in the
  // rendered window, and white for anything outside it. A capture aimed at the
  // wrong origin therefore comes back the wrong COLOR, which is the thing the
  // comparison acts on.
  it("captures the scrolled window, not the top of the document", async () => {
    const device: DeviceInfo = { platform: "chromium", kind: "app", id: "chromium-cdp-9222" };
    const page = fakeChromiumPage();
    page.scrollTo(1839);

    const pixels = await capture(
      envFor(
        device,
        vi.fn(async () => page.api)
      )
    );

    expect(page.lastClip()).toMatchObject({ x: 0, y: 1839 });
    // The visible band, not the blank rectangle above the fold.
    expect(pixelAt(pixels, 0)).toEqual(VISIBLE_BAND_RGB);
    expect(pixelAt(pixels, 0)).not.toEqual(OFF_SCREEN_RGB);
  });

  it("still clips at the document origin for an unscrolled page", async () => {
    const device: DeviceInfo = { platform: "chromium", kind: "app", id: "chromium-cdp-9222" };
    const page = fakeChromiumPage();

    const pixels = await capture(
      envFor(
        device,
        vi.fn(async () => page.api)
      )
    );

    expect(page.lastClip()).toMatchObject({ x: 0, y: 0 });
    expect(pixelAt(pixels, 0)).toEqual(VISIBLE_BAND_RGB);
  });

  it("falls back to the document origin when the layout metrics cannot be read", async () => {
    // A renderer that will not answer the metrics read leaves the capture no
    // worse off than never asking — an unscrolled clip, not a failed settle.
    const device: DeviceInfo = { platform: "chromium", kind: "app", id: "chromium-cdp-9222" };
    const page = fakeChromiumPage({ metricsError: new Error("renderer is navigating") });
    page.scrollTo(1839);

    const pixels = await capture(
      envFor(
        device,
        vi.fn(async () => page.api)
      )
    );

    expect(page.lastClip()).toMatchObject({ x: 0, y: 0 });
    expect(pixels).toMatchObject({ width: 2, height: 1 });
  });

  it("leaves Android on the simulator-server route without an iOS runtime probe", async () => {
    const file = await pngAt(tmpDir, "android.png");
    const resolveService = vi.fn(async () => ({
      transport: { screenshot: async () => ({ path: file, url: `file://${file}` }) },
    }));

    await expect(
      capture(
        envFor({ platform: "android", kind: "emulator", id: "emulator-5554" }, resolveService)
      )
    ).resolves.toMatchObject({ width: 2, height: 1 });
    expect(isTvOsSimulator).not.toHaveBeenCalled();
  });

  it.each(["ios", "android", "chromium", "vega"] as const)(
    "returns undefined (never throws) on %s when the capture backend fails",
    async (platform) => {
      // Soft by design: the caller reads undefined as "no visual evidence", so
      // a throw escaping here would fail the step on an environment problem.
      vi.mocked(captureVegaScreenshotPng).mockRejectedValue(new Error("no vvd"));
      const env = envFor({ platform, kind: "unknown", id: "some-device" }); // no resolveService

      expect(await capture(env)).toBeUndefined();
    }
  );

  it("returns undefined when the capture succeeds but the file is not a decodable PNG", async () => {
    const file = path.join(tmpDir, "garbage.png");
    await fs.writeFile(file, "not a png");
    const resolveService = vi.fn(async () => ({
      transport: { screenshot: async () => ({ path: file, url: `file://${file}` }) },
    }));

    expect(
      await capture(envFor({ platform: "ios", kind: "simulator", id: "x" }, resolveService))
    ).toBeUndefined();
    // Still cleaned up — a failed decode must not leak the file either.
    await expect(fs.access(file)).rejects.toThrow();
  });
});

describe("capturePixelsWithin", () => {
  const iosDevice: DeviceInfo = { platform: "ios", kind: "simulator", id: "ios-udid" };

  function envWith(screenshot: () => Promise<{ path: string; url: string }>): ActionEnv {
    return envFor(
      iosDevice,
      vi.fn(async () => ({ transport: { screenshot } }))
    );
  }

  it("returns the frame when the capture lands inside the deadline", async () => {
    const env = envWith(async () => {
      const file = await pngAt(tmpDir, "in-time.png");
      return { path: file, url: `file://${file}` };
    });
    await expect(capturePixelsWithin(env, Date.now() + 5_000, false)).resolves.toMatchObject({
      width: 1 + 1,
      height: 1,
    });
  });

  it("gives up rather than overrunning the caller's deadline", async () => {
    // A capture that never returns must not hold the settle past the step's
    // own timeout — the caller degrades to tree-only, it does not wait.
    const env = envWith(() => new Promise(() => {}));
    const started = Date.now();
    await expect(capturePixelsWithin(env, started + 120, false)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not attempt a capture once the deadline has already passed", async () => {
    const screenshot = vi.fn(async () => {
      const file = await pngAt(tmpDir, "too-late.png");
      return { path: file, url: `file://${file}` };
    });
    await expect(capturePixelsWithin(envWith(screenshot), Date.now() - 1, false)).resolves.toBe(
      undefined
    );
    expect(screenshot).not.toHaveBeenCalled();
  });

  it("allows the first capture the cold-stream wait and later ones the warm bound", () => {
    // The simulator-server serves captures from a live frame stream, so the
    // first read after it starts can spend the whole first-frame window; every
    // later one is answered from a stream that is already producing.
    expect(pixelCaptureTimeoutMs(iosDevice, true)).toBe(FIRST_PIXEL_CAPTURE_TIMEOUT_MS);
    expect(FIRST_PIXEL_CAPTURE_TIMEOUT_MS).toBeGreaterThan(FIRST_FRAME_WAIT_MS);
    expect(pixelCaptureTimeoutMs(iosDevice, false)).toBe(PIXEL_CAPTURE_TIMEOUT_MS);
    // Chromium answers from CDP with no stream to warm up, so its first
    // capture gets no extra grace.
    expect(
      pixelCaptureTimeoutMs({ platform: "chromium", kind: "app", id: "chromium-cdp-9222" }, true)
    ).toBe(PIXEL_CAPTURE_TIMEOUT_MS);
  });
});
