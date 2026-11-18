import { describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import type { DeviceInfo } from "@argent/registry";
import {
  capturePixelsWithin,
  PIXEL_CAPTURE_TIMEOUT_MS,
  pixelCaptureTimeoutMs,
  statusBarMaskFraction,
} from "../src/tools/flows/flow-pixels";
import type { ActionEnv } from "../src/tools/flows/flow-actions";
import { MACOS_APP_NAMESPACE } from "../src/blueprints/macos-app";
import { resolveDevice } from "../src/utils/device-info";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";

// The idle step's pixel half on a Mac app: one bytes capture through the
// in-app library, never the simulator-server route the other platforms take.
const flag = useMacosAppsFlag();

const MAC: DeviceInfo = resolveDevice("macos-app-com.argent.probe");

function tinyPngBase64(): string {
  const png = new PNG({ width: 3, height: 2 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([10, 20, 30, 255], i);
  return PNG.sync.write(png).toString("base64");
}

function envWith(call: ReturnType<typeof vi.fn>): {
  env: ActionEnv;
  resolveService: ReturnType<typeof vi.fn>;
} {
  const resolveService = vi.fn(async () => ({ call }));
  return {
    env: { device: MAC, registry: { resolveService } } as unknown as ActionEnv,
    resolveService,
  };
}

describe("macOS pixel capture", () => {
  it("captures through Screenshot.capture at half a pixel per point, bounded by the capture budget", async () => {
    const call = vi.fn(async () => ({ base64: tinyPngBase64() }));
    const { env, resolveService } = envWith(call);

    const frame = await capturePixelsWithin(env, Date.now() + 30_000, true);

    expect(frame).toMatchObject({ width: 3, height: 2 });
    expect(Array.from(frame!.data.subarray(0, 4))).toEqual([10, 20, 30, 255]);
    expect(resolveService).toHaveBeenCalledWith(`${MACOS_APP_NAMESPACE}:${MAC.id}`, {
      device: MAC,
    });
    expect(call).toHaveBeenCalledTimes(1);
    const [method, params, opts] = call.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { timeoutMs: number },
    ];
    expect(method).toBe("Screenshot.capture");
    // A quarter of a Retina window's backing pixels, as Chromium captures at dpr 2.
    expect(params).toEqual({ scale: 0.5 });
    // The first capture already gets the warm bound: no stream to wait for.
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(PIXEL_CAPTURE_TIMEOUT_MS);
  });

  it("yields no pixels, and never reaches the library, while the flag is off", async () => {
    flag.off();
    const call = vi.fn();
    const { env, resolveService } = envWith(call);

    expect(await capturePixelsWithin(env, Date.now() + 30_000, false)).toBeUndefined();
    expect(resolveService).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["a library error", vi.fn(async () => Promise.reject(new Error("No window")))],
    ["a reply with no image", vi.fn(async () => ({}))],
    [
      "bytes that are not a PNG",
      vi.fn(async () => ({ base64: Buffer.from("nope").toString("base64") })),
    ],
  ])("treats %s as no pixels", async (_label, call) => {
    const { env } = envWith(call);
    expect(await capturePixelsWithin(env, Date.now() + 30_000, false)).toBeUndefined();
  });

  it("gives a Mac app the warm bound from the first capture", () => {
    expect(pixelCaptureTimeoutMs(MAC, true)).toBe(PIXEL_CAPTURE_TIMEOUT_MS);
    expect(pixelCaptureTimeoutMs(MAC, false)).toBe(PIXEL_CAPTURE_TIMEOUT_MS);
  });

  it("masks nothing: the capture is the app window, which has no status bar", async () => {
    await expect(statusBarMaskFraction(MAC)).resolves.toBe(0);
  });
});
