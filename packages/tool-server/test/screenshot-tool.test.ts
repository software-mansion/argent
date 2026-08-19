import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";

// The tvOS and Vega branches shell out; stub their edges so each backend's
// branch can be driven without a device.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(),
}));
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));
vi.mock("../src/utils/vega-screen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/vega-screen")>()),
  captureVegaScreenshotPng: vi.fn(),
}));

import { execFile } from "node:child_process";
import { isTvOsSimulator } from "../src/utils/ios-devices";
import { captureVegaScreenshotPng } from "../src/utils/vega-screen";
import { createScreenshotTool } from "../src/tools/screenshot";

// The tool resolves its backend lazily via the registry rather than taking an
// eagerly-declared service, so a tvOS udid can branch away from the
// simulator-server it can't drive. A non-iOS-shaped udid ("ABC") skips the tvOS
// runtime probe and goes straight to simulator-server.
function simulatorServerTool(hostPath = "/tmp/screenshot.png") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "http://localhost/screenshot.png", path: hostPath }),
    })
  );
  const registry = {
    resolveService: vi.fn().mockResolvedValue({ apiUrl: "http://localhost:4949" }),
  } as unknown as import("@argent/registry").Registry;
  return createScreenshotTool(registry);
}

describe("screenshot tool", () => {
  beforeEach(() => {
    vi.mocked(isTvOsSimulator).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns an image artifact handle; includeImageInContext is an input-only flag handled by the MCP adapter", async () => {
    const screenshotTool = simulatorServerTool();

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
      mimeType: "image/png",
      hostPath: "/tmp/screenshot.png",
    });
    expect(result).not.toHaveProperty("includeImageInContext");
    expect(result).not.toHaveProperty("url");
  });

  it("tags the capture for durable saving under .argent/screenshots", async () => {
    const screenshotTool = simulatorServerTool();

    const result = await screenshotTool.execute(
      {},
      { udid: "ABC", includeImageInContext: true },
      { artifacts: new ArtifactStore() }
    );

    // Without this hint the client materializes the PNG into a session-scoped
    // temp cache that disappears with the session.
    expect(result.image.saveDir).toBe(".argent/screenshots");
  });

  it("names the saved file by device and capture time, not by the backend's temp name", async () => {
    // The simulator-server writes a bare `<hrtime>-<epochMs>.png`, which says
    // nothing in a durable directory shared across sessions.
    const screenshotTool = simulatorServerTool(
      "/tmp/simserver-x/media/821081000-1785417279821.png"
    );

    const before = Date.now();
    const result = await screenshotTool.execute(
      {},
      { udid: "ABC", includeImageInContext: true },
      { artifacts: new ArtifactStore() }
    );
    const after = Date.now();

    const match = /^screenshot-ABC-(\d+)\.png$/.exec(result.image.filename);
    expect(match, `unexpected filename ${result.image.filename}`).not.toBeNull();
    const stamp = Number(match![1]);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
    // The host path is untouched — only the presented name is argent's own.
    expect(result.image.hostPath).toBe("/tmp/simserver-x/media/821081000-1785417279821.png");
  });

  it("keeps the saved filename to a single safe path segment for an unsafe device id", async () => {
    // Two real id shapes carry a `:` that must not reach a filename the client
    // joins onto a directory: a `remote:`-prefixed simulator, and an adb
    // wireless serial (`<ip>:<port>`). Chromium and Vega ids are generated with
    // fixed prefixes and are already safe.
    const screenshotTool = simulatorServerTool();

    for (const [udid, expected] of [
      [
        "remote:22222222-2222-2222-2222-222222222222",
        "screenshot-remote-22222222-2222-2222-2222-222222222222-",
      ],
      ["192.168.1.5:5555", "screenshot-192.168.1.5-5555-"],
    ] as const) {
      const result = await screenshotTool.execute(
        {},
        { udid, includeImageInContext: true },
        { artifacts: new ArtifactStore() }
      );

      expect(result.image.filename).toMatch(
        new RegExp(`^${expected.replace(/\./g, "\\.")}\\d+\\.png$`)
      );
      expect(result.image.filename).not.toContain("/");
      expect(result.image.filename).not.toContain(":");
    }
  });

  // Every capture path has to tag its PNG, or a screenshot from that backend
  // silently reverts to the disposable temp cache. The simulator-server path is
  // covered above; these are the other three, each of which is reached only by
  // a device id of its own shape.
  describe("the other capture backends tag their captures too", () => {
    it("Chromium (CDP)", async () => {
      const registry = {
        resolveService: vi
          .fn()
          .mockResolvedValue({ captureScreenshot: async () => ({ path: "/tmp/argent-cdp.png" }) }),
      } as unknown as import("@argent/registry").Registry;

      const result = await createScreenshotTool(registry).execute(
        {},
        { udid: "chromium-cdp-9222", includeImageInContext: true },
        { artifacts: new ArtifactStore() }
      );

      expect(result.image.saveDir).toBe(".argent/screenshots");
      expect(result.image.filename).toMatch(/^screenshot-chromium-cdp-9222-\d+\.png$/);
    });

    it("tvOS (xcrun simctl io)", async () => {
      vi.mocked(isTvOsSimulator).mockResolvedValue(true);
      vi.mocked(execFile).mockImplementation(((
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (e: null, r: { stdout: string; stderr: string }) => void
      ) => cb(null, { stdout: "", stderr: "" })) as never);

      const result = await createScreenshotTool({} as never).execute(
        {},
        { udid: "6DBF83B4-0000-0000-0000-000000000000", includeImageInContext: true },
        { artifacts: new ArtifactStore() }
      );

      expect(result.image.saveDir).toBe(".argent/screenshots");
      expect(result.image.filename).toMatch(
        /^screenshot-6DBF83B4-0000-0000-0000-000000000000-\d+\.png$/
      );
    });

    it("Vega (adb emu screenrecord)", async () => {
      vi.mocked(captureVegaScreenshotPng).mockResolvedValue("/tmp/vega-screenshot-123.png");

      const result = await createScreenshotTool({} as never).execute(
        {},
        { udid: "amazon-VEGA123", includeImageInContext: true },
        { artifacts: new ArtifactStore() }
      );

      expect(result.image.saveDir).toBe(".argent/screenshots");
      expect(result.image.filename).toMatch(/^screenshot-amazon-VEGA123-\d+\.png$/);
    });
  });
});
