import fs from "fs/promises";
import os from "os";
import path from "path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore, FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { executeScreenshotDiffTool, screenshotDiffTool } from "../src/tools/screenshot-diff";
import { RUNNER_COMMAND_TIMEOUT_MS } from "../src/utils/ios-device/runner-client";

// The staged-baseline store is a module singleton keyed by device, so every test
// here uses a udid of its own rather than resetting shared state between them.
const SIMULATOR_SERVER = { simulatorServer: { apiUrl: "http://localhost:4949" } };

afterEach(() => {
  vi.useRealTimers();
});

describe("screenshot-diff staged baselines", () => {
  it("stages a live baseline capture and returns no comparison", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-staged-stage-"));
    const captured = path.join(dir, "device.png");
    await writePng(captured, 2, 2, { r: 10, g: 20, b: 30 });
    const captureScreenshot = vi.fn(
      async (_api: unknown, _rotation: unknown, _signal: unknown, _scale?: number) => ({
        url: "http://x/1.png",
        path: captured,
      })
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const result = await executeScreenshotDiffTool(
      SIMULATOR_SERVER,
      { captureBaseline: true, udid: "STAGE-1", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    // Asks for full resolution, the same as any other live side.
    expect(captureScreenshot.mock.calls[0]![3]).toBe(1.0);

    const staged = (await fs.readdir(dir)).filter((name) =>
      /^baseline-[a-f0-9]{8}\.live\.png$/.test(name)
    );
    expect(staged).toHaveLength(1);

    // No diff ran, so the result carries neither diff image.
    expect(Object.keys(result)).toEqual(["summary"]);
    expect(result.summary).toContain("Screenshot diff baseline staged");
    expect(result.summary).toContain(
      `- staged_baseline: udid=STAGE-1 captured_at=2026-01-01T00:00:00.000Z file=${staged[0]}`
    );
    expect(result.summary).toContain("no comparison ran");
  });

  it("compares a later live capture against the staged baseline and dates it in the summary", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-staged-diff-"));
    const before = path.join(dir, "before.png");
    const after = path.join(dir, "after.png");
    await writePng(before, 4, 4, { r: 10, g: 20, b: 30 });
    await writePng(after, 4, 4, { r: 220, g: 20, b: 30 });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await executeScreenshotDiffTool(
      SIMULATOR_SERVER,
      { captureBaseline: true, udid: "STAGE-2", outputDir: dir },
      { artifacts: new ArtifactStore() },
      (async () => ({ url: "http://x/1.png", path: before })) as never
    );

    // 65 seconds later, with no path carried between the two calls.
    vi.setSystemTime(new Date("2026-01-01T00:01:05.000Z"));
    const result = await executeScreenshotDiffTool(
      SIMULATOR_SERVER,
      { captureCurrent: true, udid: "STAGE-2", outputDir: dir },
      { artifacts: new ArtifactStore() },
      (async () => ({ url: "http://x/2.png", path: after })) as never
    );

    const stagedFile = (await fs.readdir(dir)).find((name) =>
      /^baseline-[a-f0-9]{8}\.live\.png$/.test(name)
    )!;
    // The provenance leads the summary: the age of the unnamed input is read
    // before any figure measured against it.
    expect(result.summary.split("\n").slice(0, 3)).toEqual([
      "Baseline:",
      `- staged_baseline: udid=STAGE-2 captured_at=2026-01-01T00:00:00.000Z age_seconds=65 file=${stagedFile}`,
      "  - captured by an earlier screenshot-diff staging call, not by this one; everything the screen did since captured_at is inside this diff",
    ]);
    expect(result.summary).toContain("Screenshot diff summary");
    expect(result.summary).toContain("- status: changed");
    expect(result.diffPath).toMatchObject({ kind: "screenshot-diff" });
  });

  it("compares a saved current PNG against the staged baseline without resolving the simulator server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-staged-savedcurrent-"));
    const before = path.join(dir, "before.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(before, 4, 4, { r: 10, g: 20, b: 30 });
    await writePng(currentPath, 4, 4, { r: 10, g: 20, b: 30 });

    await executeScreenshotDiffTool(
      SIMULATOR_SERVER,
      { captureBaseline: true, udid: "STAGE-3", outputDir: dir },
      { artifacts: new ArtifactStore() },
      (async () => ({ url: "http://x/1.png", path: before })) as never
    );

    // Neither side is live, so the tvOS-hostile SimulatorServer stays unrequested.
    const params = { currentPath, udid: "STAGE-3", outputDir: dir };
    expect(screenshotDiffTool.services(params)).toEqual({});

    const result = await executeScreenshotDiffTool({}, params, { artifacts: new ArtifactStore() });
    expect(result.summary).toContain("staged_baseline: udid=STAGE-3");
    expect(result.summary).toContain("- status: unchanged");
  });

  // Staging captures live, so it needs the SimulatorServer the pure static-PNG
  // diff deliberately leaves unresolved.
  it("resolves the simulator server for a staging call", async () => {
    expect(screenshotDiffTool.services({ captureBaseline: true, udid: "STAGE-4" })).toEqual({
      simulatorServer: {
        urn: "SimulatorServer:STAGE-4",
        options: { device: { id: "STAGE-4", platform: "android", kind: "device" } },
      },
    });

    await expect(
      executeScreenshotDiffTool({}, { captureBaseline: true, udid: "STAGE-4", outputDir: "/tmp" })
    ).rejects.toThrow("Live screenshot capture requires a simulatorServer service.");
  });

  it("keys the staged baseline by device, and takes no staging call without one", async () => {
    // udid is what the store is keyed on, so a staging call cannot omit it.
    expect(screenshotDiffTool.zodSchema!.safeParse({ captureBaseline: true }).success).toBe(false);
    expect(
      screenshotDiffTool.zodSchema!.safeParse({ captureBaseline: true, udid: "" }).success
    ).toBe(false);
    expect(
      screenshotDiffTool.zodSchema!.safeParse({ captureBaseline: true, udid: "STAGE-6-A" }).success
    ).toBe(true);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-staged-otherdevice-"));
    const before = path.join(dir, "before.png");
    await writePng(before, 4, 4, { r: 10, g: 20, b: 30 });

    await executeScreenshotDiffTool(
      SIMULATOR_SERVER,
      { captureBaseline: true, udid: "STAGE-6-A", outputDir: dir },
      { artifacts: new ArtifactStore() },
      (async () => ({ url: "http://x/1.png", path: before })) as never
    );

    await expect(
      executeScreenshotDiffTool(
        SIMULATOR_SERVER,
        { captureCurrent: true, udid: "STAGE-6-B", outputDir: dir },
        { artifacts: new ArtifactStore() },
        (async () => ({ url: "http://x/2.png", path: before })) as never
      )
    ).rejects.toThrow("No baseline is staged for STAGE-6-B.");
  });

  it("refuses a comparison when nothing was staged for the device", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-staged-none-"));
    const current = path.join(dir, "current.png");
    await writePng(current, 4, 4, { r: 10, g: 20, b: 30 });

    const error = await rejectionOf(
      executeScreenshotDiffTool({}, { currentPath: current, udid: "STAGE-7", outputDir: dir })
    );

    expect(error.message).toContain("No baseline is staged for STAGE-7.");
    expect(getFailureSignal(error)).toMatchObject({
      error_code: FAILURE_CODES.SCREENSHOT_DIFF_INPUT_INVALID,
      failure_stage: "screenshot_diff_no_staged_baseline",
      error_kind: "validation",
    });
  });

  it("refuses a comparison when the staged file has been reaped, naming when it was staged", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-staged-reaped-"));
    const before = path.join(dir, "before.png");
    const current = path.join(dir, "current.png");
    await writePng(before, 4, 4, { r: 10, g: 20, b: 30 });
    await writePng(current, 4, 4, { r: 10, g: 20, b: 30 });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-03T04:05:06.000Z"));
    await executeScreenshotDiffTool(
      SIMULATOR_SERVER,
      { captureBaseline: true, udid: "STAGE-8", outputDir: dir },
      { artifacts: new ArtifactStore() },
      (async () => ({ url: "http://x/1.png", path: before })) as never
    );

    const stagedFile = (await fs.readdir(dir)).find((name) =>
      /^baseline-[a-f0-9]{8}\.live\.png$/.test(name)
    )!;
    await fs.rm(path.join(dir, stagedFile));

    const error = await rejectionOf(
      executeScreenshotDiffTool({}, { currentPath: current, udid: "STAGE-8", outputDir: dir })
    );

    expect(error.message).toContain(
      "The baseline staged for STAGE-8 at 2026-02-03T04:05:06.000Z is no longer on disk."
    );
    expect(getFailureSignal(error)?.failure_stage).toBe("screenshot_diff_staged_baseline_gone");
  });

  it("replaces a device's staged baseline when it is staged again", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-staged-restage-"));
    const first = path.join(dir, "first.png");
    const second = path.join(dir, "second.png");
    const current = path.join(dir, "current.png");
    await writePng(first, 4, 4, { r: 10, g: 20, b: 30 });
    await writePng(second, 4, 4, { r: 220, g: 20, b: 30 });
    await writePng(current, 4, 4, { r: 220, g: 20, b: 30 });

    for (const source of [first, second]) {
      await executeScreenshotDiffTool(
        SIMULATOR_SERVER,
        { captureBaseline: true, udid: "STAGE-9", outputDir: dir },
        { artifacts: new ArtifactStore() },
        (async () => ({ url: "http://x/1.png", path: source })) as never
      );
    }

    // The second staging call wins: `current` matches it and differs from the first.
    const result = await executeScreenshotDiffTool(
      {},
      { currentPath: current, udid: "STAGE-9", outputDir: dir },
      { artifacts: new ArtifactStore() }
    );
    expect(result.summary).toContain("- status: unchanged");
  });

  it("keeps the staged baseline usable for repeated comparisons", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-staged-repeat-"));
    const before = path.join(dir, "before.png");
    const current = path.join(dir, "current.png");
    await writePng(before, 4, 4, { r: 10, g: 20, b: 30 });
    await writePng(current, 4, 4, { r: 220, g: 20, b: 30 });

    await executeScreenshotDiffTool(
      SIMULATOR_SERVER,
      { captureBaseline: true, udid: "STAGE-10", outputDir: dir },
      { artifacts: new ArtifactStore() },
      (async () => ({ url: "http://x/1.png", path: before })) as never
    );

    for (let call = 0; call < 2; call++) {
      const result = await executeScreenshotDiffTool(
        {},
        { currentPath: current, udid: "STAGE-10", outputDir: dir },
        { artifacts: new ArtifactStore() }
      );
      expect(result.summary).toContain("staged_baseline: udid=STAGE-10");
      expect(result.summary).toContain("- status: changed");
    }
  });

  it("still diffs a live baseline against a saved current instead of staging it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-staged-fixture-"));
    const before = path.join(dir, "before.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(before, 4, 4, { r: 10, g: 20, b: 30 });
    await writePng(currentPath, 4, 4, { r: 220, g: 20, b: 30 });

    const result = await executeScreenshotDiffTool(
      SIMULATOR_SERVER,
      { captureBaseline: true, currentPath, udid: "STAGE-11", outputDir: dir },
      { artifacts: new ArtifactStore() },
      (async () => ({ url: "http://x/1.png", path: before })) as never
    );

    // A comparison ran, and nothing was left staged behind it.
    expect(result.diffPath).toMatchObject({ kind: "screenshot-diff" });
    expect(result.summary.startsWith("Screenshot diff summary")).toBe(true);
    await expect(
      executeScreenshotDiffTool({}, { currentPath, udid: "STAGE-11", outputDir: dir })
    ).rejects.toThrow("No baseline is staged for STAGE-11.");
  });

  // Staging on a physical iPhone routes through the on-device runner, not the
  // simulator-server. Pins that the staging branch reaches the same backend
  // `services()` resolves for a captureBaseline call on hardware.
  it("declares the runner service for a staging call on a physical iPhone", () => {
    const udid = "00008110-000978540290401E";
    expect(screenshotDiffTool.services({ captureBaseline: true, udid })).toEqual({
      iosDeviceRunner: {
        urn: `IosDeviceRunner:${udid}`,
        options: { device: { id: udid, platform: "ios", kind: "device" } },
      },
    });
  });

  it("stages and later compares through the runner on a physical iPhone", async () => {
    const udid = "00008120-0011223344556677";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-staged-device-"));
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        imageBase64: pngBytes(4, 4, { r: 10, g: 20, b: 30 }).toString("base64"),
      })
      .mockResolvedValueOnce({
        imageBase64: pngBytes(4, 4, { r: 220, g: 20, b: 30 }).toString("base64"),
      });

    const staged = await executeScreenshotDiffTool(
      { iosDeviceRunner: { run, udid } },
      { captureBaseline: true, udid, outputDir: dir },
      { artifacts: new ArtifactStore() }
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenNthCalledWith(
      1,
      { command: "screenshot" },
      { readOnly: true, timeoutMs: RUNNER_COMMAND_TIMEOUT_MS }
    );
    expect(Object.keys(staged)).toEqual(["summary"]);
    expect(staged.summary).toContain("Screenshot diff baseline staged");
    const stagedFile = (await fs.readdir(dir)).find((name) =>
      /^baseline-[a-f0-9]{8}\.live\.png$/.test(name)
    );
    expect(stagedFile).toBeDefined();

    const compared = await executeScreenshotDiffTool(
      { iosDeviceRunner: { run, udid } },
      { captureCurrent: true, udid, outputDir: dir },
      { artifacts: new ArtifactStore() }
    );

    // The current side captured live through the runner too.
    expect(run).toHaveBeenCalledTimes(2);
    expect(compared.summary.startsWith(`Baseline:\n- staged_baseline: udid=${udid}`)).toBe(true);
    expect(compared.summary).toContain("Screenshot diff summary");
    expect(compared.summary).toContain("- status: changed");
    expect(compared.diffPath).toMatchObject({ kind: "screenshot-diff" });
  });

  it("refuses a staging call on a physical iPhone without the runner service", async () => {
    await expect(
      executeScreenshotDiffTool(
        {},
        { captureBaseline: true, udid: "00008130-00AABBCCDDEEFF00", outputDir: "/tmp" }
      )
    ).rejects.toThrow("requires an iosDeviceRunner service");
  });

  it("still refuses every invalid combination of saved and live inputs", async () => {
    const base = { udid: "STAGE-12", outputDir: "/tmp" };

    await expect(
      executeScreenshotDiffTool({}, { ...base, captureBaseline: true, captureCurrent: true })
    ).rejects.toThrow("captureBaseline and captureCurrent cannot both be true");

    // No current side, so a staging test placed before the conflict checks would
    // take this call for a staging request and drop the baselinePath it names.
    await expect(
      executeScreenshotDiffTool(
        {},
        {
          ...base,
          captureBaseline: true,
          baselinePath: "/tmp/baseline.png",
        }
      )
    ).rejects.toThrow("Provide either baselinePath or captureBaseline, not both.");

    await expect(
      executeScreenshotDiffTool(
        {},
        {
          ...base,
          captureCurrent: true,
          currentPath: "/tmp/current.png",
        }
      )
    ).rejects.toThrow("Provide either currentPath or captureCurrent, not both.");

    // A baseline side alone is still not a comparison, and neither is a bare udid.
    await expect(
      executeScreenshotDiffTool({}, { ...base, baselinePath: "/tmp/baseline.png" })
    ).rejects.toThrow("currentPath is required unless captureCurrent is true");
    await expect(executeScreenshotDiffTool({}, base)).rejects.toThrow(
      "currentPath is required unless captureCurrent is true"
    );
  });
});

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject");
}

async function writePng(
  filePath: string,
  width: number,
  height: number,
  fill: { r: number; g: number; b: number }
): Promise<void> {
  await fs.writeFile(filePath, pngBytes(width, height, fill));
}

function pngBytes(
  width: number,
  height: number,
  fill: { r: number; g: number; b: number }
): Buffer {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (width * y + x) * 4;
      png.data[offset] = fill.r;
      png.data[offset + 1] = fill.g;
      png.data[offset + 2] = fill.b;
      png.data[offset + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}
