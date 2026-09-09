import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { ArtifactStore, type Registry } from "@argent/registry";

// The physical-iOS route shells out (`sips` for the downscale) via
// promisify(execFile), so mock child_process the way screenshot-tv-scale.test.ts
// does. promisify appends a node-style callback as the last argument.
const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

// The rotation-less android-shaped captures here run the real adb rotation
// probe against the host's adb server; a wedged one stalls the tests for its
// full timeout. Rotation is orthogonal to what these tests pin.
vi.mock("../src/utils/device-orientation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/device-orientation")>()),
  readAndroidSurfaceRotation: vi.fn(async () => null),
}));

import { createScreenshotTool, downscalePngInPlace } from "../src/tools/screenshot";
import { IOS_DEVICE_RUNNER_NAMESPACE } from "../src/blueprints/ios-device-runner";
import { RUNNER_COMMAND_TIMEOUT_MS } from "../src/utils/ios-device/runner-client";
import {
  createMoqTransport,
  getScreenshotScale,
  httpScreenshot,
} from "../src/utils/simulator-client";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type ExecFileCallback = (e: Error | null, r?: { stdout: string; stderr: string }) => void;

function callbackOf(args: unknown[]): ExecFileCallback | undefined {
  return args.find((a) => typeof a === "function") as ExecFileCallback | undefined;
}

function failAllSpawns(message = "unexpected execFile call"): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    callbackOf(args)?.(new Error(message));
  });
}

function mockSips(dims: { width: number; height: number }): { zTargets: () => string[] } {
  const zCalls: string[] = [];
  execFileMock.mockImplementation((...args: unknown[]) => {
    const file = args[0] as string;
    const argv = (args[1] as string[]) ?? [];
    const cb = callbackOf(args);
    if (file === "sips" && argv[0] === "-g") {
      cb?.(null, {
        stdout: `pixelWidth: ${dims.width}\npixelHeight: ${dims.height}\n`,
        stderr: "",
      });
      return;
    }
    if (file === "sips" && argv[0] === "-Z") {
      zCalls.push(argv[1]);
      cb?.(null, { stdout: "", stderr: "" });
      return;
    }
    cb?.(new Error(`unexpected execFile ${file} ${argv.join(" ")}`));
  });
  return { zTargets: () => zCalls };
}

beforeEach(() => {
  execFileMock.mockReset();
  failAllSpawns();
});

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
    // sorted into the wrong list. A tethered iPhone captures through the
    // XCUITest runner, which never sees `rotation`, so it belongs in the
    // unrotated half.
    const description = createScreenshotTool(registry).zodSchema!.shape.rotation.description!;
    expect(description).toContain("Applied on Android and on local iOS simulators");
    expect(description).toContain(
      "Apple TV, Vega, physical iPhones and remote iOS simulators accept it and capture unrotated"
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

describe("physical-iOS route: the runner is the only capture path", () => {
  const UDID = "00008110-000978540290401E";
  const DEVICE = { id: UDID, platform: "ios", kind: "device" };

  function runnerStub(imageBase64: string | undefined) {
    const run = vi.fn(async () => ({ imageBase64 }));
    const resolveService = vi.fn(async () => ({ run, udid: UDID }));
    return { run, resolveService };
  }

  function screenshotDevice(resolveService: unknown, scale = 1.0) {
    const tool = createScreenshotTool({ resolveService } as unknown as Registry);
    return tool.execute(
      {},
      { udid: UDID, scale, includeImageInContext: true },
      { artifacts: new ArtifactStore() }
    );
  }

  it("captures through the runner, on a client window that outlasts the runner's own budget", async () => {
    const { run, resolveService } = runnerStub(Buffer.from("png-bytes").toString("base64"));

    const result = await screenshotDevice(resolveService);

    expect(resolveService).toHaveBeenCalledWith(`${IOS_DEVICE_RUNNER_NAMESPACE}:${UDID}`, {
      device: DEVICE,
    });
    // PROTOCOL.md's invariant: a client window at or below the runner's own 30s
    // screenshot budget swallows its COMMAND_TIMED_OUT verdict as a raw
    // transport timeout and forces journal recovery for an answer already on
    // the way, so the documented 45s client default is the only right value.
    expect(RUNNER_COMMAND_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(run).toHaveBeenCalledWith(
      { command: "screenshot" },
      { readOnly: true, timeoutMs: RUNNER_COMMAND_TIMEOUT_MS }
    );
    expect(result.image.hostPath).toContain("argent-ios-device-screenshot-");
    await expect(fs.readFile(result.image.hostPath, "utf8")).resolves.toBe("png-bytes");
    await fs.rm(result.image.hostPath, { force: true });
  });

  it("throws when the runner answers without inline image data", async () => {
    const { resolveService } = runnerStub(undefined);

    await expect(screenshotDevice(resolveService)).rejects.toThrow(
      "Runner screenshot returned no inline image data."
    );
  });
});

describe("downscalePngInPlace: shared device-route downscale", () => {
  it("caps the longest actual side at the requested scale", async () => {
    const sips = mockSips({ width: 1920, height: 1080 });
    await downscalePngInPlace("/tmp/cap.png", 0.5);
    expect(sips.zTargets()).toEqual(["960"]);
  });

  it("spawns nothing at scale 1", async () => {
    await downscalePngInPlace("/tmp/cap.png", 1.0);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("keeps the full-resolution file when sips fails (best-effort)", async () => {
    failAllSpawns("sips: command not found");
    await expect(downscalePngInPlace("/tmp/cap.png", 0.5)).resolves.toBeUndefined();
  });
});
