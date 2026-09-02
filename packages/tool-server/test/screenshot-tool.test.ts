import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";
import { createScreenshotTool } from "../src/tools/screenshot";
import {
  createMoqTransport,
  getScreenshotScale,
  httpScreenshot,
} from "../src/utils/simulator-client";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// The rotation-less android-shaped captures here run the real adb rotation
// probe against the host's adb server; a wedged one stalls the tests for its
// full timeout. Rotation is orthogonal to what these tests pin.
vi.mock("../src/utils/device-orientation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/device-orientation")>()),
  readAndroidSurfaceRotation: vi.fn(async () => null),
}));

describe("screenshot tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns an image artifact handle; includeImageInContext is an input-only flag handled by the MCP adapter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: "http://localhost/screenshot.png",
          path: "/tmp/screenshot.png",
        }),
      })
    );

    // The tool resolves its backend lazily via the registry rather than taking
    // an eagerly-declared service, so a tvOS udid can branch away from the
    // simulator-server it can't drive. A non-iOS-shaped udid ("ABC") skips the
    // tvOS runtime probe and goes straight to simulator-server.
    const registry = {
      resolveService: vi.fn().mockResolvedValue({ apiUrl: "http://localhost:4949" }),
    } as unknown as import("@argent/registry").Registry;
    const screenshotTool = createScreenshotTool(registry);

    const params = {
      udid: "ABC",
      includeImageInContext: false,
    };
    screenshotTool.zodSchema!.parse(params);

    const result = await screenshotTool.execute({}, params, { artifacts: new ArtifactStore() });

    // The PNG is returned as an artifact handle the MCP client materializes —
    // the unreachable `127.0.0.1` media URL is no longer surfaced.
    expect(result.image).toMatchObject({
      __argentArtifact: true,
      kind: "screenshot",
      filename: "screenshot.png",
      mimeType: "image/png",
      hostPath: "/tmp/screenshot.png",
    });
    expect(result).not.toHaveProperty("includeImageInContext");
    expect(result).not.toHaveProperty("url");
  });

  it("omitting `scale` puts the tool-server's own scale on the wire", async () => {
    // Half of an equality several tool descriptions and skills rest on: a
    // baseline captured here with `scale` omitted has to come out at the size
    // screenshot-diff's live capture falls back to. That side is asserted in
    // screenshot-diff-tool.test.ts; this is the one that would go stale if this
    // path ever resolved a default of its own.
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "");
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: "http://localhost/s.png", path: "/tmp/s.png" }),
        } as unknown as Response;
      })
    );
    const registry = {
      resolveService: vi.fn().mockResolvedValue({ apiUrl: "http://localhost:4949" }),
    } as unknown as import("@argent/registry").Registry;

    await createScreenshotTool(registry).execute(
      {},
      { udid: "ABC", includeImageInContext: false },
      { artifacts: new ArtifactStore() }
    );

    expect(bodies).toEqual([{ scale: getScreenshotScale() }]);
  });

  it("puts rotation on the wire for a local sim, and loses it on the remote transport", async () => {
    // This enumeration has been wrong twice: first as Chromium-only, then with
    // iOS put in wholesale — `ios-remote` is its own Platform whose MoQ
    // transport reads `opts.scale` and nothing else (#822). Nothing else in the
    // suite reads the sentence, so pin it against the two paths that disagree.
    //
    // Read the ambient scale instead of stubbing it and this fails on correct
    // code for anyone who exports 1.0: httpScreenshot omits an in-band 1.0, so
    // the body loses the key the assertion is written around.
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "");
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: "http://localhost/s.png", path: "/tmp/s.png" }),
        } as unknown as Response;
      })
    );
    const registry = {
      resolveService: vi.fn().mockResolvedValue({ apiUrl: "http://localhost:4949" }),
    } as unknown as import("@argent/registry").Registry;

    await createScreenshotTool(registry).execute(
      {},
      { udid: "ABC", rotation: "LandscapeLeft", includeImageInContext: false },
      { artifacts: new ArtifactStore() }
    );
    expect(bodies).toEqual([{ rotation: "LandscapeLeft", scale: getScreenshotScale() }]);

    // Same call, one transport in front of it: httpScreenshot hands `rotation`
    // to the transport, and createMoqTransport drops it on the floor.
    const seen: unknown[] = [];
    const transport = createMoqTransport(
      {
        sendControl: async () => {},
        close: async () => {},
        screenshot: async (opts: unknown) => {
          seen.push(opts);
          return Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
        },
      } as never,
      { pasteText: async () => {} }
    );
    await httpScreenshot({ apiUrl: "moq://remote", transport } as never, "LandscapeLeft");
    expect(seen).toEqual([{ scale: getScreenshotScale() }]);

    // Both halves verbatim, not the two ends of the sentence: matching only
    // those leaves the middle free, and the middle is where a platform gets
    // sorted into the wrong list. A tethered iPhone belongs in neither — its
    // UDID does not match the iOS-simulator shape `classifyDevice` tests, so
    // nothing routes it through a rotation-capable path.
    const description = createScreenshotTool(registry).zodSchema!.shape.rotation.description!;
    expect(description).toContain("Applied on Android and on local iOS simulators");
    expect(description).not.toContain("tethered");
    expect(description).toContain(
      "Apple TV, Vega and remote iOS simulators accept it and capture unrotated"
    );
  });

  it("hands Chromium no scale of its own, so nothing is downscaled by default", async () => {
    // The other half of the split this tool's `scale` description and
    // argent-device-interact both state: 25% on iOS/Android, untouched on
    // Chromium. `execute` resolves getScreenshotScale() just above this branch
    // and deliberately does not pass it, which is exactly the line a
    // platform-unifying cleanup collapses.
    const captureScreenshot = vi.fn().mockResolvedValue({ path: "/tmp/c.png" });
    const registry = {
      resolveService: vi.fn().mockResolvedValue({ captureScreenshot }),
    } as unknown as import("@argent/registry").Registry;

    await createScreenshotTool(registry).execute(
      {},
      { udid: "chromium-cdp-9222", rotation: "LandscapeLeft", includeImageInContext: false },
      { artifacts: new ArtifactStore() }
    );

    // `rotation` rides the same object and the same post-processing branch, so
    // dropping it returns an unrotated image and says nothing. Read off the call
    // rather than matched as a shape: an absent `scale` key reads the same as
    // the explicit undefined it is today.
    const opts = captureScreenshot.mock.calls[0]![0] as { scale?: number; rotation?: string };
    expect(opts.scale).toBeUndefined();
    expect(opts.rotation).toBe("LandscapeLeft");

    // Rotating and downscaling share one optional dependency on this branch, so
    // a description naming it for only one of them sends the reader at a no-op.
    const shape = createScreenshotTool(registry).zodSchema!.shape;
    for (const field of ["rotation", "scale", "downscaler"] as const) {
      expect(shape[field].description, field).toContain("`sharp`");
    }
  });
});
