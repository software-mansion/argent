import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { ArtifactStore, type Registry } from "@argent/registry";

// `tvTargetLongSide` shells `sips -g pixelWidth -g pixelHeight` to read the
// capture's real dimensions, then returns the `sips -Z` target as
// longest-actual-side * scale, or the 576 px default without a scale. Mock child_process.execFile so we can feed it a
// 4K vs a non-4K (1920x1080) Apple TV capture and assert the target.
const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

const { isTvOsMock } = vi.hoisted(() => ({ isTvOsMock: vi.fn(() => true) }));
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: async () => isTvOsMock(),
}));
vi.mock("../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device-sets")>()),
  simctlArgsForUdid: async (_udid: string, args: readonly string[]) => ["simctl", ...args],
}));

const isAndroidTvMock = vi.fn<(serial: string) => Promise<boolean>>();
const runAdbMock = vi.fn<(argv: string[]) => Promise<string>>();
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  isAndroidTv: (serial: string) => isAndroidTvMock(serial),
  runAdb: (argv: string[]) => runAdbMock(argv),
}));
const screenSizeMock = vi.fn<(serial: string) => Promise<{ width: number; height: number }>>();
vi.mock("../src/utils/android-screen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/android-screen")>()),
  getAndroidScreenSize: (serial: string) => screenSizeMock(serial),
}));
vi.mock("../src/utils/device-orientation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/device-orientation")>()),
  readAndroidSurfaceRotation: async () => null,
}));
vi.mock("../src/utils/vega-vvd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/vega-vvd")>()),
  discoverVegaConsolePort: async () => 5554,
}));

import {
  ANDROID_TV_PROBE_BUDGET_MS,
  createScreenshotTool,
  tvTargetLongSide,
} from "../src/tools/screenshot";

type ExecFileCallback = (e: Error | null, r?: { stdout: string; stderr: string }) => void;

function callbackOf(args: unknown[]): ExecFileCallback | undefined {
  return args.find((a) => typeof a === "function") as ExecFileCallback | undefined;
}

// promisify(execFile) appends a node-style callback as the last argument. Reply
// with the given sips `-g` stdout via that callback when present.
function mockSipsDims(stdout: string): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    callbackOf(args)?.(null, { stdout, stderr: "" });
  });
}

describe("tvTargetLongSide — tvOS screenshot scaling", () => {
  beforeEach(() => execFileMock.mockReset());

  it("scales against the real long side for a 4K (3840x2160) capture", async () => {
    mockSipsDims("pixelWidth: 3840\npixelHeight: 2160\n");
    expect(await tvTargetLongSide("/tmp/cap.png", 0.3)).toBe(1152); // 3840 * 0.3
  });

  it("regression: scales against 1920 for a non-4K Apple TV capture (no 2x blowup)", async () => {
    // The standard non-4K "Apple TV" sim captures at 1920x1080. The old code
    // hardcoded 3840, so `-Z 1152` against a 1920-wide image yielded an
    // effective 0.6x — twice the requested 0.3. The target must be 1920*0.3=576.
    mockSipsDims("pixelWidth: 1920\npixelHeight: 1080\n");
    expect(await tvTargetLongSide("/tmp/cap.png", 0.3)).toBe(576);
  });

  it("falls back to the 4K long side when the dimension probe fails", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      callbackOf(args)?.(new Error("sips: command not found"));
    });
    expect(await tvTargetLongSide("/tmp/cap.png", 0.3)).toBe(1152); // 3840 * 0.3 fallback
  });

  // Without a scale, a 4K and a 1080p capture of the same layout come out the
  // same size.
  it.each([
    [3840, 2160],
    [1920, 1080],
  ])("targets 576 px without a scale for a %ix%i capture", async (width, height) => {
    mockSipsDims(`pixelWidth: ${width}\npixelHeight: ${height}\n`);
    expect(await tvTargetLongSide("/tmp/cap.png", undefined)).toBe(576);
  });

  it("never upscales a capture smaller than the default", async () => {
    mockSipsDims("pixelWidth: 400\npixelHeight: 225\n");
    expect(await tvTargetLongSide("/tmp/cap.png", undefined)).toBe(400);
  });
});

describe("screenshot tool on an Apple TV simulator", () => {
  const TV = "770B7963-10E3-4A46-A5E0-ED496278E124";
  const ENV = "ARGENT_SCREENSHOT_SCALE";

  afterEach(() => {
    delete process.env[ENV];
  });

  // Records every `sips -Z` target; `xcrun simctl io` and `sips -g` succeed.
  async function zTargetsFor(
    params: { scale?: number },
    dims = { width: 3840, height: 2160 }
  ): Promise<string[]> {
    const zCalls: string[] = [];
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] as string[]) ?? [];
      if (args[0] === "sips" && argv[0] === "-Z") zCalls.push(argv[1]);
      callbackOf(args)?.(null, {
        stdout: `pixelWidth: ${dims.width}\npixelHeight: ${dims.height}\n`,
        stderr: "",
      });
    });
    const tool = createScreenshotTool({ resolveService: vi.fn() } as unknown as Registry);
    const parsed = tool.zodSchema!.parse({ udid: TV, ...params }) as Parameters<
      typeof tool.execute
    >[1];
    await tool.execute({}, parsed, { artifacts: new ArtifactStore() });
    return zCalls;
  }

  it("downscales to 576 px with no scale and no env override", async () => {
    delete process.env[ENV];
    expect(await zTargetsFor({})).toEqual(["576"]);
    expect(await zTargetsFor({}, { width: 1920, height: 1080 })).toEqual(["576"]);
  });

  it("honours ARGENT_SCREENSHOT_SCALE as a fraction of the capture", async () => {
    process.env[ENV] = "0.5";
    expect(await zTargetsFor({})).toEqual(["1920"]);
  });

  it("ignores an invalid ARGENT_SCREENSHOT_SCALE and keeps the 576 px default", async () => {
    process.env[ENV] = "abc";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await zTargetsFor({})).toEqual(["576"]);
    warn.mockRestore();
  });

  it("honours an explicit scale over the env override", async () => {
    process.env[ENV] = "0.5";
    expect(await zTargetsFor({ scale: 0.25 })).toEqual(["960"]);
  });

  it("skips the downscale at scale 1", async () => {
    expect(await zTargetsFor({ scale: 1 })).toEqual([]);
  });
});

describe("screenshot tool on an Android TV", () => {
  const ENV = "ARGENT_SCREENSHOT_SCALE";

  beforeEach(() => {
    isAndroidTvMock.mockReset().mockResolvedValue(true);
    screenSizeMock.mockReset().mockResolvedValue({ width: 1920, height: 1080 });
  });
  afterEach(() => {
    delete process.env[ENV];
    vi.unstubAllGlobals();
  });

  // The `scale` simulator-server is asked for; absent means a 1.0 capture.
  async function requestedScale(
    params: { scale?: number },
    { udid = "emulator-5556", resolveMs = 0 } = {}
  ): Promise<number | undefined> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "http://localhost/s.png", path: "/tmp/s.png" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = { apiUrl: "http://localhost:4949" };
    const registry = {
      resolveService: vi.fn(
        () =>
          new Promise((resolve) => (resolveMs ? setTimeout(resolve, resolveMs, api) : resolve(api)))
      ),
    } as unknown as Registry;
    const tool = createScreenshotTool(registry);
    const parsed = tool.zodSchema!.parse({ udid, ...params }) as Parameters<typeof tool.execute>[1];
    await tool.execute({}, parsed, { artifacts: new ArtifactStore() });
    return JSON.parse(fetchMock.mock.calls[0]![1].body).scale;
  }

  it.each([
    [3840, 2160, 0.15],
    [1920, 1080, 0.3],
    [1280, 720, 0.45],
  ])("scales a %ix%i display to a 576 px long side", async (width, height, expected) => {
    screenSizeMock.mockResolvedValue({ width, height });
    expect(await requestedScale({})).toBeCloseTo(expected, 10);
  });

  it("never upscales a display smaller than the default", async () => {
    screenSizeMock.mockResolvedValue({ width: 400, height: 225 });
    expect(await requestedScale({})).toBeUndefined();
  });

  it("keeps the 0.25 default on an Android phone", async () => {
    isAndroidTvMock.mockResolvedValue(false);
    expect(await requestedScale({})).toBe(0.25);
  });

  // An emulator-NNNN slot is reused, so an earlier phone verdict must not stick.
  it("re-probes a serial on every capture", async () => {
    isAndroidTvMock.mockResolvedValueOnce(false);
    expect(await requestedScale({})).toBe(0.25);
    expect(await requestedScale({})).toBeCloseTo(0.3, 10);
  });

  it("probes neither an iOS simulator nor a capture with an explicit scale", async () => {
    isTvOsMock.mockReturnValueOnce(false);
    expect(await requestedScale({}, { udid: "8BDBFD47-E557-41BA-926B-2DD39A17A53E" })).toBe(0.25);
    expect(await requestedScale({ scale: 0.2 })).toBe(0.2);
    expect(isAndroidTvMock).not.toHaveBeenCalled();
  });

  it("falls back to the 0.25 default when the TV probe fails", async () => {
    isAndroidTvMock.mockRejectedValue(new Error("adb: device offline"));
    expect(await requestedScale({})).toBe(0.25);
  });

  it("falls back to the 0.25 default when the TV probe outlasts its budget", async () => {
    vi.useFakeTimers();
    try {
      isAndroidTvMock.mockReturnValue(new Promise<boolean>(() => {}));
      const scale = requestedScale({});
      await vi.advanceTimersByTimeAsync(ANDROID_TV_PROBE_BUDGET_MS);
      expect(await scale).toBe(0.25);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a probe that finishes just inside its budget", async () => {
    vi.useFakeTimers();
    try {
      isAndroidTvMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, ANDROID_TV_PROBE_BUDGET_MS - 1, true))
      );
      const scale = requestedScale({});
      await vi.advanceTimersByTimeAsync(ANDROID_TV_PROBE_BUDGET_MS);
      expect(await scale).toBeCloseTo(0.3, 10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits past its budget for a probe that beats the simulator-server start", async () => {
    vi.useFakeTimers();
    try {
      isAndroidTvMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, ANDROID_TV_PROBE_BUDGET_MS + 500, true))
      );
      const scale = requestedScale({}, { resolveMs: ANDROID_TV_PROBE_BUDGET_MS + 2_000 });
      await vi.advanceTimersByTimeAsync(ANDROID_TV_PROBE_BUDGET_MS + 2_000);
      expect(await scale).toBeCloseTo(0.3, 10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the 0.25 default when the display size probe fails", async () => {
    screenSizeMock.mockRejectedValue(new Error("adb: device offline"));
    expect(await requestedScale({})).toBe(0.25);
  });

  it("honours ARGENT_SCREENSHOT_SCALE and an explicit scale", async () => {
    process.env[ENV] = "0.5";
    expect(await requestedScale({})).toBe(0.5);
    expect(await requestedScale({ scale: 0.2 })).toBe(0.2);
    expect(isAndroidTvMock).not.toHaveBeenCalled();
  });
});

describe("screenshot tool on Vega", () => {
  const ENV = "ARGENT_SCREENSHOT_SCALE";

  afterEach(() => {
    delete process.env[ENV];
  });

  // Size of the screenshot artifact for a VVD display of the given size.
  async function capturedSize(
    params: { scale?: number },
    dims: { width: number; height: number }
  ): Promise<{ width: number; height: number }> {
    // `adb emu screenrecord screenshot <dir>` writes the capture into <dir>.
    runAdbMock.mockReset().mockImplementation(async (argv) => {
      const png = new PNG({ width: dims.width, height: dims.height });
      await writeFile(join(argv[argv.length - 1]!, "shot.png"), PNG.sync.write(png));
      return "";
    });
    const tool = createScreenshotTool({ resolveService: vi.fn() } as unknown as Registry);
    const parsed = tool.zodSchema!.parse({
      udid: "amazon-4a27df03c9777152",
      ...params,
    }) as Parameters<typeof tool.execute>[1];
    const { image } = await tool.execute({}, parsed, { artifacts: new ArtifactStore() });
    const out = PNG.sync.read(await readFile(image.hostPath));
    return { width: out.width, height: out.height };
  }

  it.each([
    [1920, 1080],
    [1280, 720],
  ])("downscales a %ix%i capture to a 576 px long side", async (width, height) => {
    expect(await capturedSize({}, { width, height })).toEqual({ width: 576, height: 324 });
  });

  it("never upscales a capture smaller than the default", async () => {
    expect(await capturedSize({}, { width: 400, height: 225 })).toEqual({
      width: 400,
      height: 225,
    });
  });

  it("honours ARGENT_SCREENSHOT_SCALE and an explicit scale", async () => {
    process.env[ENV] = "0.5";
    expect(await capturedSize({}, { width: 1920, height: 1080 })).toEqual({
      width: 960,
      height: 540,
    });
    expect(await capturedSize({ scale: 0.25 }, { width: 1920, height: 1080 })).toEqual({
      width: 480,
      height: 270,
    });
  });
});
