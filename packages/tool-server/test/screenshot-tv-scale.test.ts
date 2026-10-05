import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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

vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: async () => true,
}));
vi.mock("../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device-sets")>()),
  simctlArgsForUdid: async (_udid: string, args: readonly string[]) => ["simctl", ...args],
}));

import { createScreenshotTool, tvTargetLongSide } from "../src/tools/screenshot";

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
