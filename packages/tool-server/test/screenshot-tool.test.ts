import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";
import { createScreenshotTool } from "../src/tools/screenshot";
import { captureHarmonyScreenshotPng } from "../src/utils/harmony-screen";

vi.mock("../src/utils/harmony-screen", () => ({ captureHarmonyScreenshotPng: vi.fn() }));
vi.mock("../src/utils/check-deps", () => ({ ensureDep: vi.fn(async () => {}) }));

describe("screenshot tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
      filename: "screenshot.png",
      mimeType: "image/png",
      hostPath: "/tmp/screenshot.png",
    });
    expect(result).not.toHaveProperty("includeImageInContext");
    expect(result).not.toHaveProperty("url");
  });

  it("refuses a rotation override on HarmonyOS rather than returning an unrotated capture", async () => {
    const registry = {
      resolveService: vi.fn(),
    } as unknown as import("@argent/registry").Registry;
    const screenshotTool = createScreenshotTool(registry);

    // `uitest screenCap` writes the display in its current orientation and has
    // no override, so the only alternative to this error is a capture whose
    // orientation silently contradicts the parameter that was accepted.
    await expect(
      screenshotTool.execute(
        {},
        {
          udid: "harmony-025DEK236V035771",
          rotation: "LandscapeLeft",
          includeImageInContext: true,
        },
        { artifacts: new ArtifactStore() }
      )
    ).rejects.toThrow(/rotation is not supported on HarmonyOS/);
    expect(captureHarmonyScreenshotPng).not.toHaveBeenCalled();
  });
});
