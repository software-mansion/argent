import fs from "fs/promises";
import os from "os";
import path from "path";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";
import { executeScreenshotDiffTool, screenshotDiffTool } from "../src/tools/screenshot-diff";

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

  it("requires udid and always declares the simulator-server service", () => {
    expect(
      screenshotDiffTool.zodSchema!.safeParse({
        baselinePath: "/tmp/baseline.png",
        currentPath: "/tmp/current.png",
        outputDir: "/tmp",
      }).success
    ).toBe(false);

    const params = {
      baselinePath: "/tmp/baseline.png",
      currentPath: "/tmp/current.png",
      udid: "ABC",
      outputDir: "/tmp",
    };

    expect(screenshotDiffTool.zodSchema!.safeParse(params).success).toBe(true);
    expect(screenshotDiffTool.services(params)).toEqual({
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
    await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
    const captureScreenshot = vi.fn(async () => ({
      url: "http://localhost/current.png",
      path: capturedPath,
    }));

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
