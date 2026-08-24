import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "@argent/registry";
import { createScreenshotTool } from "../src/tools/screenshot";

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

  it("uses a human name in both the artifact filename and the real staged path", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-tool-test-"));
    const sourcePath = path.join(sourceDir, "624543000-1786034937633.png");
    const png = Buffer.from("fake-png");
    await fs.writeFile(sourcePath, png);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: "http://localhost/624543000-1786034937633.png",
          path: sourcePath,
        }),
      })
    );

    const registry = {
      resolveService: vi.fn().mockResolvedValue({ apiUrl: "http://localhost:4949" }),
    } as unknown as import("@argent/registry").Registry;
    const screenshotTool = createScreenshotTool(registry);
    const params = {
      udid: "ABC",
      name: "Checkout complete.png",
      includeImageInContext: true,
    };
    screenshotTool.zodSchema!.parse(params);
    let stagedPath: string | undefined;

    try {
      const result = await screenshotTool.execute({}, params, { artifacts: new ArtifactStore() });
      stagedPath = result.image.hostPath;

      expect(result.image).toMatchObject({
        __argentArtifact: true,
        filename: "Checkout-complete.png",
        mimeType: "image/png",
      });
      expect(path.basename(result.image.hostPath)).toBe("Checkout-complete.png");
      expect(result.image.hostPath).not.toBe(sourcePath);
      expect(await fs.readFile(result.image.hostPath)).toEqual(png);
    } finally {
      await fs.rm(sourceDir, { recursive: true, force: true });
      if (stagedPath) {
        await fs.rm(path.dirname(stagedPath), { recursive: true, force: true });
      }
    }
  });

  it("rejects screenshot names that could be interpreted as paths", () => {
    const registry = {
      resolveService: vi.fn(),
    } as unknown as import("@argent/registry").Registry;
    const screenshotTool = createScreenshotTool(registry);

    expect(
      screenshotTool.zodSchema!.safeParse({ udid: "ABC", name: "../../checkout" }).success
    ).toBe(false);
    expect(
      screenshotTool.zodSchema!.safeParse({ udid: "ABC", name: "checkout\nsecret" }).success
    ).toBe(false);
  });
});
