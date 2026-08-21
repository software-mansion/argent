import fs from "fs/promises";
import os from "os";
import path from "path";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";
import { executeScreenshotDiffTool, screenshotDiffTool } from "../src/tools/screenshot-diff";
import { captureHarmonyScreenshotPng } from "../src/utils/harmony-screen";

// HarmonyOS captures over `hdc`; both are stubbed so the live-capture branch is
// exercised without a device.
vi.mock("../src/utils/harmony-screen", () => ({ captureHarmonyScreenshotPng: vi.fn() }));
vi.mock("../src/utils/check-deps", () => ({ ensureDep: vi.fn(async () => {}) }));

describe("screenshotDiffTool", () => {
  it("rejects public tuning options so defaults stay internal", () => {
    const result = screenshotDiffTool.zodSchema!.safeParse({
      baselinePath: "/tmp/baseline.png",
      currentPath: "/tmp/current.png",
      udid: "ABC",
      outputDir: "/tmp",
      includeTextAnalysis: false,
      threshold: 0.2,
      textChangeMinConfidence: 0.9,
      maxRegions: 3,
    });

    expect(result.success).toBe(false);
  });

  it("requires udid and only declares the simulator-server service for live captures", () => {
    expect(
      screenshotDiffTool.zodSchema!.safeParse({
        baselinePath: "/tmp/baseline.png",
        currentPath: "/tmp/current.png",
        outputDir: "/tmp",
      }).success
    ).toBe(false);

    // A pure static-PNG diff needs no SimulatorServer — requesting it
    // unconditionally would fail on tvOS sims that have no such backend.
    const staticParams = {
      baselinePath: "/tmp/baseline.png",
      currentPath: "/tmp/current.png",
      udid: "ABC",
      outputDir: "/tmp",
    };
    expect(screenshotDiffTool.zodSchema!.safeParse(staticParams).success).toBe(true);
    expect(screenshotDiffTool.services(staticParams)).toEqual({});

    // A live capture resolves and starts the SimulatorServer for the device.
    const liveParams = {
      baselinePath: "/tmp/baseline.png",
      captureCurrent: true,
      udid: "ABC",
      outputDir: "/tmp",
    };
    expect(screenshotDiffTool.zodSchema!.safeParse(liveParams).success).toBe(true);
    expect(screenshotDiffTool.services(liveParams)).toEqual({
      simulatorServer: {
        urn: "SimulatorServer:ABC",
        options: {
          device: {
            id: "ABC",
            platform: "android",
            // A non-`emulator-*` serial resolves to a physical device.
            kind: "device",
          },
        },
      },
    });
  });

  it("returns only the summary and diff artifact paths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-tool-"));
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 2, 2, { r: 10, g: 20, b: 30 });
    await writePng(currentPath, 2, 2, { r: 10, g: 20, b: 30 });

    const result = await executeScreenshotDiffTool(
      {},
      {
        baselinePath,
        currentPath,
        udid: "ABC",
        outputDir: dir,
      },
      { artifacts: new ArtifactStore() }
    );

    // Diff outputs leave as artifact handles so a remote client can download
    // them; hostPath still points at the requested outputDir.
    expect(result.summary).toContain("Screenshot diff summary");
    expect(result.diffPath).toMatchObject({
      __argentArtifact: true,
      hostPath: path.join(dir, "current-diff.png"),
      mimeType: "image/png",
    });
    expect(result.contextDiffPath).toMatchObject({
      __argentArtifact: true,
      hostPath: path.join(dir, "current-context-diff.png"),
      mimeType: "image/png",
    });
    expect(Object.keys(result).sort()).toEqual(["contextDiffPath", "diffPath", "summary"]);
  });

  it("captures one live side at full resolution and copies it into outputDir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-live-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(dir, "captured.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
    const signal = AbortSignal.timeout(1000);
    const captureScreenshot = vi.fn(async () => ({
      url: "http://localhost/current.png",
      path: capturedPath,
    }));

    const result = await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      {
        baselinePath,
        captureCurrent: true,
        udid: "ABC",
        rotation: "LandscapeLeft",
        outputDir: dir,
      },
      { signal, artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    expect(captureScreenshot).toHaveBeenCalledWith(
      { apiUrl: "http://localhost:4949" },
      "LandscapeLeft",
      signal,
      1.0
    );

    const entries = await fs.readdir(dir);
    const liveCaptures = entries.filter((name) => /^current-[a-f0-9]{8}\.live\.png$/.test(name));
    expect(liveCaptures).toHaveLength(1);
    const liveBaseName = path.parse(liveCaptures[0]!).name;
    await expect(fs.stat(path.join(dir, liveCaptures[0]!))).resolves.toMatchObject({
      size: expect.any(Number),
    });
    expect(result.diffPath).toMatchObject({
      hostPath: path.join(dir, `${liveBaseName}-diff.png`),
    });
  });

  it("falls back to the default scale when the full-resolution capture fails (Android framebuffer mismatch)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-fallback-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(dir, "captured.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
    // Full-res (scale 1.0) fails the way the Android simulator-server does;
    // the default-scale retry (no scale arg) succeeds.
    const captureScreenshot = vi.fn(
      async (_api: unknown, _rotation: unknown, _signal: unknown, scale?: number) => {
        if (scale === 1.0) {
          throw new Error("Screenshot failed: wrong data size, expected 7853760 got 17627328.");
        }
        return { url: "http://localhost/current.png", path: capturedPath };
      }
    );

    const result = await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      { baselinePath, captureCurrent: true, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    // Full-res attempted first, then a default-scale retry without an explicit scale.
    expect(captureScreenshot).toHaveBeenCalledTimes(2);
    expect(captureScreenshot.mock.calls[0]![3]).toBe(1.0);
    expect(captureScreenshot.mock.calls[1]![3]).toBeUndefined();
    const liveCaptures = (await fs.readdir(dir)).filter((name) =>
      /^current-[a-f0-9]{8}\.live\.png$/.test(name)
    );
    expect(liveCaptures).toHaveLength(1);
    expect(result.diffPath).toBeTruthy();
  });

  it("propagates the error when both the full-res capture and the fallback fail", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-bothfail-"));
    const baselinePath = path.join(dir, "baseline.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    const captureScreenshot = vi.fn(
      async (_api: unknown, _rotation: unknown, _signal: unknown, scale?: number) => {
        throw new Error(scale === 1.0 ? "full-res failed" : "device offline");
      }
    );

    await expect(
      executeScreenshotDiffTool(
        { simulatorServer: { apiUrl: "http://localhost:4949" } },
        { baselinePath, captureCurrent: true, udid: "ABC", outputDir: dir },
        {},
        captureScreenshot as never
      )
    ).rejects.toThrow("device offline");
    expect(captureScreenshot).toHaveBeenCalledTimes(2);
  });

  it("uses a fresh hashed filename for each live capture so concurrent diffs do not collide", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-unique-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(dir, "captured.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    // Re-written per call, as a real backend does: each capture writes its own
    // uniquely named file, and the diff removes the one it copied from.
    const captureScreenshot = vi.fn(async () => {
      await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
      return { url: "http://localhost/current.png", path: capturedPath };
    });

    await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      { baselinePath, captureCurrent: true, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );
    await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      { baselinePath, captureCurrent: true, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    const liveCaptures = (await fs.readdir(dir)).filter((name) =>
      /^current-[a-f0-9]{8}\.live\.png$/.test(name)
    );
    expect(liveCaptures).toHaveLength(2);
    expect(new Set(liveCaptures).size).toBe(2);
  });

  it("does not leave the backend's own capture behind once it has been copied in", async () => {
    // Every backend writes its capture to a uniquely named file in `tmpdir()`
    // that nothing else prunes — measured at 213KB per call for one 1320x2856
    // frame, since this path captures at `scale: 1.0`. The copy under
    // `outputDir` is what outlives the call; the original is scratch.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-scratch-"));
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "argent-fake-backend-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(scratch, "backend-capture.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    const captureScreenshot = vi.fn(async () => {
      await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
      return { url: "http://localhost/current.png", path: capturedPath };
    });

    await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      { baselinePath, captureCurrent: true, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    expect(await fs.readdir(scratch)).toEqual([]);
    expect(
      (await fs.readdir(dir)).filter((n) => /^current-[a-f0-9]{8}\.live\.png$/.test(n))
    ).toHaveLength(1);
  });

  it("does not leave the capture behind when the copy into `outputDir` fails", async () => {
    // The failure path is the one that accumulates: a diff that cannot write
    // its copy still captured a full-resolution frame, and retrying leaves one
    // per attempt in `tmpdir()`.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-ro-"));
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "argent-fake-backend-"));
    const baselinePath = path.join(os.tmpdir(), `argent-baseline-${Date.now()}.png`);
    const capturedPath = path.join(scratch, "backend-capture.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    const captureScreenshot = vi.fn(async () => {
      await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
      return { url: "http://localhost/current.png", path: capturedPath };
    });
    await fs.chmod(dir, 0o500);

    try {
      await expect(
        executeScreenshotDiffTool(
          { simulatorServer: { apiUrl: "http://localhost:4949" } },
          { baselinePath, captureCurrent: true, udid: "ABC", outputDir: dir },
          { artifacts: new ArtifactStore() },
          captureScreenshot as never
        )
      ).rejects.toThrow();
    } finally {
      await fs.chmod(dir, 0o700);
    }

    expect(await fs.readdir(scratch)).toEqual([]);
  });

  it("validates mutually exclusive saved and live inputs at execute time", async () => {
    await expect(
      executeScreenshotDiffTool(
        {},
        {
          baselinePath: "/tmp/baseline.png",
          currentPath: "/tmp/current.png",
          captureCurrent: true,
          udid: "ABC",
          outputDir: "/tmp",
        }
      )
    ).rejects.toThrow("Provide either currentPath or captureCurrent, not both.");
  });

  it("captures a live HarmonyOS side over hdc instead of the simulator-server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-harmony-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(dir, "captured.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
    vi.mocked(captureHarmonyScreenshotPng).mockResolvedValue(capturedPath);
    // Passed to prove the sim-server path is not taken: it would be called with
    // this stub, and HarmonyOS has no simulator-server controller to call.
    const captureScreenshot = vi.fn();

    const result = await executeScreenshotDiffTool(
      {},
      { baselinePath, captureCurrent: true, udid: "harmony-025DEK236V035771", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    expect(captureScreenshot).not.toHaveBeenCalled();
    // Full resolution, not ARGENT_SCREENSHOT_SCALE's 0.25 default: a diff against
    // a full-res baseline is only as precise as the coarser of the two images.
    expect(captureHarmonyScreenshotPng).toHaveBeenCalledWith({
      connectKey: "025DEK236V035771",
      scale: 1.0,
    });
    const liveCaptures = (await fs.readdir(dir)).filter((name) =>
      /^current-[a-f0-9]{8}\.live\.png$/.test(name)
    );
    expect(liveCaptures).toHaveLength(1);
    expect(result.diffPath).toBeTruthy();
  });

  it("rejects a rotation override on a live HarmonyOS capture", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-harmony-rot-"));
    const baselinePath = path.join(dir, "baseline.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    vi.mocked(captureHarmonyScreenshotPng).mockClear().mockResolvedValue(baselinePath);

    // `uitest screenCap` has no orientation argument, so accepting this would
    // diff an unrotated capture against a rotated baseline and report the whole
    // screen as changed.
    await expect(
      executeScreenshotDiffTool(
        {},
        {
          baselinePath,
          captureCurrent: true,
          udid: "harmony-025DEK236V035771",
          rotation: "LandscapeLeft",
          outputDir: dir,
        },
        { artifacts: new ArtifactStore() }
      )
    ).rejects.toThrow(/rotation is not supported/);
    expect(captureHarmonyScreenshotPng).not.toHaveBeenCalled();
  });

  it("still diffs two saved PNGs on HarmonyOS when a rotation is passed", async () => {
    // rotation only ever applies to a live capture, and is inert on every
    // platform for a two-path diff — rejecting it here would make HarmonyOS
    // the one platform where an unused parameter fails the call.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-harmony-static-"));
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 2, 2, { r: 1, g: 2, b: 3 });
    await writePng(currentPath, 2, 2, { r: 1, g: 2, b: 3 });
    vi.mocked(captureHarmonyScreenshotPng).mockClear();

    const result = await executeScreenshotDiffTool(
      {},
      {
        baselinePath,
        currentPath,
        udid: "harmony-025DEK236V035771",
        rotation: "LandscapeLeft",
        outputDir: dir,
      },
      { artifacts: new ArtifactStore() }
    );

    expect(result.summary).toContain("Screenshot diff summary");
    expect(captureHarmonyScreenshotPng).not.toHaveBeenCalled();
  });

  it("declares no simulator-server service for a HarmonyOS live capture", () => {
    // Resolving the iOS/Android-only blueprint for a HarmonyOS device throws
    // before the capture path runs.
    expect(
      screenshotDiffTool.services({
        baselinePath: "/tmp/baseline.png",
        captureCurrent: true,
        udid: "harmony-025DEK236V035771",
        outputDir: "/tmp",
      })
    ).toEqual({});
  });

  // The boundary probe reports `presentOnHost: false` for ANY path that does not
  // already exist here, so a local agent naming a fresh output directory looked
  // exactly like a remote client's own directory and was silently redirected to
  // a temp dir. A directory we can create next to an existing parent is ours.
  it("creates and honors an outputDir that does not exist yet on this host", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-fresh-"));
    const baselinePath = path.join(parent, "baseline.png");
    const currentPath = path.join(parent, "current.png");
    await writePng(baselinePath, 2, 2, { r: 10, g: 20, b: 30 });
    await writePng(currentPath, 2, 2, { r: 200, g: 20, b: 30 });

    const outputDir = path.join(parent, "diff-out");

    const result = await executeScreenshotDiffTool(
      {},
      { baselinePath, currentPath, udid: "ABC", outputDir },
      {
        artifacts: new ArtifactStore(),
        fileInputs: {
          outputDir: { clientPath: outputDir, presentOnHost: false, viaUpload: false },
        },
      }
    );

    expect(result.diffPath).toMatchObject({
      hostPath: path.join(outputDir, "current-diff.png"),
    });
    await expect(fs.stat(path.join(outputDir, "current-diff.png"))).resolves.toBeTruthy();
  });

  // The probe runs before the create, so a directory that appears in between —
  // a concurrent diff on the same outputDir, or the agent creating it itself —
  // reaches mkdir as EEXIST. That is the directory the caller asked for, not a
  // reason to redirect them to a temp dir.
  it("honors an outputDir that raced into existence after the probe", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-race-"));
    const baselinePath = path.join(parent, "baseline.png");
    const currentPath = path.join(parent, "current.png");
    await writePng(baselinePath, 2, 2, { r: 10, g: 20, b: 30 });
    await writePng(currentPath, 2, 2, { r: 200, g: 20, b: 30 });

    // Exists on disk, but the probe captured the earlier state.
    const outputDir = path.join(parent, "diff-out");
    await fs.mkdir(outputDir);

    const result = await executeScreenshotDiffTool(
      {},
      { baselinePath, currentPath, udid: "ABC", outputDir },
      {
        artifacts: new ArtifactStore(),
        fileInputs: {
          outputDir: { clientPath: outputDir, presentOnHost: false, viaUpload: false },
        },
      }
    );

    expect(result.diffPath).toMatchObject({
      hostPath: path.join(outputDir, "current-diff.png"),
    });
    await expect(fs.stat(path.join(outputDir, "current-diff.png"))).resolves.toBeTruthy();
  });

  // The remote case must still fall back: a client-side path whose parent does
  // not exist here cannot be created, so diffs go to a temp dir as before.
  it("falls back to a temp dir when outputDir is not creatable on this host", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-remote-"));
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 2, 2, { r: 10, g: 20, b: 30 });
    await writePng(currentPath, 2, 2, { r: 200, g: 20, b: 30 });

    // Parent does not exist on this host — a remote client's own directory.
    const outputDir = path.join(dir, "no-such-parent", "nested", "diff-out");

    const result = await executeScreenshotDiffTool(
      {},
      { baselinePath, currentPath, udid: "ABC", outputDir },
      {
        artifacts: new ArtifactStore(),
        fileInputs: {
          outputDir: { clientPath: outputDir, presentOnHost: false, viaUpload: false },
        },
      }
    );

    const diffHostPath = (result.diffPath as { hostPath: string }).hostPath;
    expect(diffHostPath.startsWith(outputDir)).toBe(false);
    expect(diffHostPath).toContain("argent-screenshot-diff");
  });
});

async function writePng(
  filePath: string,
  width: number,
  height: number,
  fill: { r: number; g: number; b: number }
): Promise<void> {
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

  await fs.writeFile(filePath, PNG.sync.write(png));
}
