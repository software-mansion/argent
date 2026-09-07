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

vi.mock("../src/utils/harmony-screen", () => ({ captureHarmonyScreenshotPng: vi.fn() }));
vi.mock("../src/utils/check-deps", () => ({ ensureDep: vi.fn(async () => {}) }));

import { createScreenshotTool, downscalePngInPlace } from "../src/tools/screenshot";
import { captureHarmonyScreenshotPng } from "../src/utils/harmony-screen";
import { IOS_DEVICE_RUNNER_NAMESPACE } from "../src/blueprints/ios-device-runner";
import { RUNNER_COMMAND_TIMEOUT_MS } from "../src/utils/ios-device/runner-client";

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
