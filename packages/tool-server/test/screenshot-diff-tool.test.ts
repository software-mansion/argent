import fs from "fs/promises";
import os from "os";
import path from "path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";
import { executeScreenshotDiffTool, screenshotDiffTool } from "../src/tools/screenshot-diff";
import { createScreenshotTool } from "../src/tools/screenshot";
import { getScreenshotScale } from "../src/utils/simulator-client";
import { createRegistry } from "../src/utils/setup-registry";
import { definitionsById } from "./helpers/catalog";
import { agentFacingText, sentencesClaimingSize } from "./helpers/size-claims";

describe("screenshotDiffTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("carries each spelling its vocabulary claims, and none of the near misses", () => {
    // Every size-claim sweep is exactly as wide as this regex, and most of its
    // alternatives match no sentence in the corpus, so they could be deleted
    // unnoticed. The negatives are the exclusions the helper's own
    // comment promises — `native resolution` (argent-screen-recording uses it
    // correctly for h264), a range mention, the percentage form that asserts
    // the opposite, and the three tokens that merely contain "scale".
    const claims: Array<[string, boolean]> = [
      ["The capture is at full resolution.", true],
      ["Saved full-res for later.", true],
      ["Written at full size.", true],
      ["The bytes are unscaled.", true],
      ["Pixels map 1:1 with the device.", true],
      ["It is never downscaled.", true],
      ["The frame is not resampled.", true],
      ["Kept at 100% of original resolution.", true],
      ["Written at original resolution.", true],
      ["Pass scale: 1.0 for a baseline.", true],
      ["h264 frames stay at native resolution.", false],
      ["`scale` accepts values from 0.01 to 1.0.", false],
      ["Downscaled to 30% of original resolution.", false],
      ["grayscale = 1 is the default.", false],
      ["upscale: 1 leaves it alone.", false],
      ["Set ARGENT_SCREENSHOT_SCALE to change it.", false],
    ];
    expect(claims.map(([text]) => [text, sentencesClaimingSize(text).length > 0] as const)).toEqual(
      claims
    );
  });

  it("reads schema descriptions at every depth an input_schema advertises", () => {
    // Depth as well as kind of surface: the sweep above is only as wide as this
    // walk, and narrowing it is invisible from the outside — the catalogue check
    // goes on passing over a shorter list. Pinned against a schema written here
    // rather than a live tool's nested fields, so renaming one of those is not a
    // failure in a file about screenshot-diff prose.
    const def = {
      id: "synthetic",
      description: "",
      inputSchema: {
        type: "object",
        properties: {
          top: { type: "string", description: "top-level" },
          nested: {
            type: "object",
            properties: { inner: { type: "string", description: "nested object" } },
          },
          list: {
            type: "array",
            items: {
              type: "object",
              properties: { field: { type: "string", description: "array item" } },
            },
          },
          either: {
            anyOf: [
              { type: "string", description: "first arm" },
              { type: "number", description: "second arm" },
            ],
          },
        },
      },
    } as unknown as Parameters<typeof agentFacingText>[0];

    expect(agentFacingText(def).filter(([, text]) => text !== "")).toEqual([
      ["top", "top-level"],
      ["nested.inner", "nested object"],
      ["list[].field", "array item"],
      ["either|0", "first arm"],
      ["either|1", "second arm"],
    ]);
  });

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
    const liveServices = {
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
    };
    expect(screenshotDiffTool.services(liveParams)).toEqual(liveServices);

    // The other live flag reaches the same captureLiveInput, so it needs the
    // same service — asserted separately because a condition covering only
    // captureCurrent satisfies every other test in the suite while leaving
    // captureBaseline to throw "requires a simulatorServer service".
    expect(
      screenshotDiffTool.services({
        currentPath: "/tmp/current.png",
        captureBaseline: true,
        udid: "ABC",
        outputDir: "/tmp",
      })
    ).toEqual(liveServices);
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

  it("returns the summary alone when the aspect ratios differ, and writes no diff images", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-mismatch-"));
    const baselinePath = path.join(dir, "baseline.png");
    const currentPath = path.join(dir, "current.png");
    await writePng(baselinePath, 4, 2, { r: 10, g: 20, b: 30 });
    await writePng(currentPath, 2, 8, { r: 10, g: 20, b: 30 });

    const result = await executeScreenshotDiffTool(
      {},
      { baselinePath, currentPath, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() }
    );

    expect(result.summary).toContain("- status: dimension_mismatch");
    expect(Object.keys(result).sort()).toEqual(["summary"]);
    // Both inputs and nothing else. Scoped to the two-saved-path form on
    // purpose: a live capture is copied into outputDir before the comparison
    // runs, so that form leaves its `current-<hex>.live.png` behind on this
    // status too — the same intermediate a successful diff keeps.
    expect((await fs.readdir(dir)).sort()).toEqual(["baseline.png", "current.png"]);
    expect(screenshotDiffTool.description).toContain(
      "both images are omitted on dimension_mismatch"
    );
  });

  it("normalizes inside the tolerance its description names, and mismatches outside it", async () => {
    // The description is the only place that 1% appears in prose and nothing
    // read it, so both its threshold and its direction could be inverted with
    // the suite green. Against a 100x200 baseline, 101x200 is 0.99% off in
    // aspect and 102x200 is 1.96%: the pair straddles ASPECT_RATIO_TOLERANCE,
    // so halving or doubling the constant moves one of these two rows.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-tolerance-"));
    const run = async (name: string, width: number): Promise<string> => {
      const baselinePath = path.join(dir, `${name}-baseline.png`);
      const currentPath = path.join(dir, `${name}-current.png`);
      await writePng(baselinePath, width, 200, { r: 0, g: 0, b: 0 });
      await writePng(currentPath, 100, 200, { r: 0, g: 0, b: 0 });
      const result = await executeScreenshotDiffTool(
        {},
        { baselinePath, currentPath, udid: "ABC", outputDir: dir },
        { artifacts: new ArtifactStore() }
      );
      return result.summary;
    };

    // Resampled toward the smaller-area side, which is the 100x200 current one.
    expect(await run("inside", 101)).toContain(
      "- size_normalized: baseline=101x200 current=100x200 compared_at=100x200"
    );
    expect(await run("outside", 102)).toContain("- status: dimension_mismatch");

    expect(screenshotDiffTool.description).toContain(
      "aspect ratios agree to within about 1% but whose resolutions differ are resampled to the smaller-area side"
    );
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

  it("falls back to the tool-server's screenshot scale when the full-resolution capture fails (Android framebuffer mismatch)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-fallback-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(dir, "captured.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
    // Full-res (scale 1.0) fails the way the Android simulator-server does;
    // the retry, which passes no scale and so resolves the tool-server's own,
    // succeeds.
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

    // Full-res attempted first, then a retry at the tool-server's own scale.
    // Which argument carries that scale is not asserted — passing it explicitly
    // produces the same request, and the wire tests below pin the value itself.
    expect(captureScreenshot).toHaveBeenCalledTimes(2);
    expect(captureScreenshot.mock.calls[0]![3]).toBe(1.0);
    const liveCaptures = (await fs.readdir(dir)).filter((name) =>
      /^current-[a-f0-9]{8}\.live\.png$/.test(name)
    );
    expect(liveCaptures).toHaveLength(1);
    expect(result.diffPath).toBeTruthy();
  });

  it.each([
    { env: "", expected: 0.3 },
    { env: "0.6", expected: 0.6 },
  ])(
    "sends the scale the tool-server resolves on the retry (env $env)",
    async ({ env, expected }) => {
      vi.stubEnv("ARGENT_SCREENSHOT_SCALE", env);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-wire-"));
      const baselinePath = path.join(dir, "baseline.png");
      const capturedPath = path.join(dir, "captured.png");
      await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
      await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
      const bodies = stubEmulatorRejectingFullRes(capturedPath);

      const result = await executeScreenshotDiffTool(
        { simulatorServer: { apiUrl: "http://127.0.0.1:4949" } },
        { baselinePath, captureCurrent: true, udid: "emulator-5554", outputDir: dir },
        { artifacts: new ArtifactStore() }
      );

      // Asserted on the wire rather than on an injected capture stub, because
      // the scale the descriptions name is the one httpScreenshot resolves: a
      // 1.0 request carries no `scale` at all, and only the retry reveals it.
      // Both rows matter — with only the unset one, a retry that hardcoded 0.3
      // would pass while ignoring the configured scale the prose promises.
      expect(bodies).toEqual([{}, { scale: expected }]);
      expect(result.summary).toContain("Screenshot diff summary");
    }
  );

  it("names the resolved fallback scale in prose wherever it quotes it", () => {
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "");
    // The prose quotes this number as a literal, so it drifts the moment
    // DEFAULT_SCREENSHOT_SCALE moves; nothing else reads the two together.
    // Whole phrases, not the bare number: `toContain("0.3")` is also satisfied
    // by "0.35", and by prose that drops the env var and keeps the digits.
    const fallback = getScreenshotScale();
    const shape = screenshotDiffTool.zodSchema!.shape;
    const registry = {
      resolveService: vi.fn(),
    } as unknown as import("@argent/registry").Registry;
    const scaleDescription = createScreenshotTool(registry).zodSchema!.shape.scale.description;

    expect(shape.captureBaseline.description).toContain(
      `ARGENT_SCREENSHOT_SCALE, ${fallback} by default`
    );
    expect(shape.captureCurrent.description).toContain(
      `ARGENT_SCREENSHOT_SCALE, ${fallback} by default`
    );
    // The platform list, not just the figure after it: which side of the split
    // a platform sits on is the half an agent acts on, and it is free to be
    // re-partitioned while the figure stays right. Apple TV takes the resolved
    // scale (index.ts hands `tvScreenshot` the `?? getScreenshotScale()` value,
    // which sips-downscales below 1), Chromium is handed `params.scale` alone.
    expect(scaleDescription).toContain(
      `On iOS, Android, Apple TV and Vega, defaults to ARGENT_SCREENSHOT_SCALE env var, or ${fallback} whenever that is unset or outside (0,1]`
    );
    expect(scaleDescription).toContain("On Chromium the default is 1.0 (no downscale)");
    // The hazard the rest of that paragraph exists for, on the one surface an
    // agent reads with no skill loaded — `screenshot` is alwaysLoad.
    expect(scaleDescription).toContain("wrong data size");
    // …and the Fails line, which is where an agent looks to find out whether
    // that hazard ends the call or is absorbed. It ends it.
    expect(createScreenshotTool(registry).description).toContain(
      "if the device rejects a capture at the requested scale"
    );
    expect(screenshotDiffTool.description).toContain("a requested live capture cannot be taken");
  });

  it("does not promise a full-resolution capture, or a full-size diff image", () => {
    // Both sentences are pinned as phrases: reword either and this fails, which
    // is the point — a reword has to be checked against captureLiveInput and
    // writeDiffArtifacts again.
    const registry = {
      resolveService: vi.fn(),
    } as unknown as import("@argent/registry").Registry;

    expect(screenshotDiffTool.description).toContain(
      "otherwise the tool-server's screenshot scale"
    );
    expect(screenshotDiffTool.description).toContain(
      "diffPath is the diff at the size the comparison ran at"
    );
    // A positive phrase leaves room for a contradicting sentence beside it, so
    // pin the whole collection instead. Over the whole catalogue: the claim
    // moves between the two tools that make it — `screenshot` captures the
    // baseline `screenshot-diff` reads — and there is no reason it stops there.
    const expected: Record<string, string[]> = {
      // The capture's resolution cannot be banned outright — it is genuinely
      // attempted at full resolution — so the condition is what gets pinned.
      "screenshot-diff.description": [
        "Accepts saved baseline/current PNG paths, or one saved PNG plus one live capture from a device — full resolution when that capture succeeds, otherwise the tool-server's screenshot scale.",
      ],
      "screenshot-diff.captureBaseline": [
        "Capture the baseline screenshot live before diffing — at full resolution when that capture succeeds, otherwise at the tool-server's screenshot scale (ARGENT_SCREENSHOT_SCALE, 0.3 by default; at 1.0 the retry repeats the request that just failed, leaving a device that cannot stream a full frame with no fallback — capture both sides with `screenshot` at an explicit scale and pass saved paths instead).",
      ],
      "screenshot-diff.captureCurrent": [
        "Capture the current screenshot live before diffing — at full resolution when that capture succeeds, otherwise at the tool-server's screenshot scale (ARGENT_SCREENSHOT_SCALE, 0.3 by default; at 1.0 the retry repeats the request that just failed, leaving a device that cannot stream a full frame with no fallback — capture both sides with `screenshot` at an explicit scale and pass saved paths instead).",
      ],
      "screenshot.scale": [
        "Some Android emulators cannot stream a full-resolution frame and reject scale: 1.0 with a `wrong data size` error; omit `scale` there, which is where screenshot-diff's own live capture lands once its 1.0 attempt fails, so a baseline saved that way matches it — unless ARGENT_SCREENSHOT_SCALE is itself 1.0, where omitting it repeats the rejected request and both sides have to be saved at the same explicit scale instead.",
      ],
    };
    const swept: string[] = [];
    for (const def of definitionsById(createRegistry()).values()) {
      for (const [surface, text] of agentFacingText(def)) {
        const key = `${def.id}.${surface}`;
        swept.push(key);
        expect(sentencesClaimingSize(text), key).toEqual(expected[key] ?? []);
      }
    }
    // A pin left behind by a renamed field is consulted from the surface side
    // only, so it goes quiet rather than red.
    expect(Object.keys(expected).filter((key) => !swept.includes(key))).toEqual([]);
    // And the reach itself: drop a kind of surface from agentFacingText and the
    // sweep goes on passing over a shorter list.
    expect(swept).toEqual(
      expect.arrayContaining([
        "screenshot-diff.description",
        "screenshot-diff.searchHint",
        "screenshot-diff.completedMsg",
        "screenshot-diff.baselinePath",
      ])
    );
    // Suppression is about where the bytes go, not what resolution they are:
    // conditioning it on a full-resolution capture sends agents at the call that
    // fails on these emulators. Pinned whole, because such a condition
    // re-attaches anywhere inside the sentence.
    expect(createScreenshotTool(registry).zodSchema!.shape.includeImageInContext.description).toBe(
      "Default true. Set false only when capturing a baseline/current PNG for screenshot-diff — the file is still written, but the image bytes are not attached to the agent context."
    );
  });

  it("has nothing lower to retry when ARGENT_SCREENSHOT_SCALE is 1.0, so the capture fails", async () => {
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "1.0");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-env1-"));
    const baselinePath = path.join(dir, "baseline.png");
    const capturedPath = path.join(dir, "captured.png");
    await writePng(baselinePath, 2, 2, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 2, 2, { r: 0, g: 0, b: 0 });
    const bodies = stubEmulatorRejectingFullRes(capturedPath);

    await expect(
      executeScreenshotDiffTool(
        { simulatorServer: { apiUrl: "http://127.0.0.1:4949" } },
        { baselinePath, captureCurrent: true, udid: "emulator-5554", outputDir: dir },
        { artifacts: new ArtifactStore() }
      )
    ).rejects.toThrow("Screenshot failed: wrong data size, expected 7853760 got 17627328.");

    // httpScreenshot omits an in-band 1.0, so the retry serializes to the same
    // bytes as the attempt that just failed — the behaviour both flags'
    // descriptions warn about. The same stub succeeds at 0.3 in the test above.
    expect(bodies).toEqual([{}, {}]);
  });

  it("captures the baseline live against a saved current, naming that side's file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-screenshot-diff-baseline-"));
    const currentPath = path.join(dir, "current.png");
    const capturedPath = path.join(dir, "captured.png");
    // Deliberately different sizes, same aspect: the summary labels the two
    // sides, so this is what proves the live capture landed in the baseline
    // slot. Equal-sized fixtures pass just as well with the sides swapped.
    await writePng(currentPath, 2, 4, { r: 0, g: 0, b: 0 });
    await writePng(capturedPath, 4, 8, { r: 0, g: 0, b: 0 });
    const captureScreenshot = vi.fn(
      async (_api: unknown, _rotation: unknown, _signal: unknown, _scale?: number) => ({
        url: "http://localhost/baseline.png",
        path: capturedPath,
      })
    );

    const result = await executeScreenshotDiffTool(
      { simulatorServer: { apiUrl: "http://localhost:4949" } },
      { currentPath, captureBaseline: true, udid: "ABC", outputDir: dir },
      { artifacts: new ArtifactStore() },
      captureScreenshot as never
    );

    expect(result.summary).toContain("- size_normalized: baseline=4x8 current=2x4 compared_at=2x4");
    // Named for its side so the directory says which one was live; the diff
    // artifacts are named after currentPath either way.
    const liveCaptures = (await fs.readdir(dir)).filter((name) =>
      /^baseline-[a-f0-9]{8}\.live\.png$/.test(name)
    );
    expect(liveCaptures).toHaveLength(1);
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
    expect(captureScreenshot.mock.calls[0]![3]).toBe(1.0);
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

/**
 * Stands in for an Android emulator whose framebuffer cannot stream a full
 * frame: `httpScreenshot` omits `scale` from the body for a 1.0 capture, and
 * that is the request this rejects — the way the real server does, HTTP 200
 * with an in-band `error`. Returns the request bodies as they went out.
 */
function stubEmulatorRejectingFullRes(capturedPath: string): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () =>
          body.scale === undefined
            ? { error: "wrong data size, expected 7853760 got 17627328" }
            : { url: "http://127.0.0.1:4949/media/shot.png", path: capturedPath },
      } as unknown as Response;
    })
  );
  return bodies;
}

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
