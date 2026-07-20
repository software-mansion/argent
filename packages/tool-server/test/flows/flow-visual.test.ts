import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { runSnapshot } from "../../src/tools/flows/flow-visual";
import { ArtifactStore } from "../../src/artifacts";
import type { DiffPngFilesOptions } from "../../src/tools/screenshot-diff/screenshot-diff";
import {
  settleTree,
  invokeOnDevice,
  waitForFrame,
  type ActionEnv,
} from "../../src/tools/flows/flow-actions";

// Stub settle + capture so the tests exercise only the baseline write/diff decision.
const h = vi.hoisted(() => ({
  shotPath: "",
  mismatchPercentage: 0,
  writeContextDiff: false,
  /** Set by the differ mock: the context diff it wrote inside outputDir. */
  contextDiffPath: "",
  /** Set by the differ mock: the scratch outputDir runSnapshot handed it. */
  outputDir: "",
  /** Set by the differ mock: the currentPath it was asked to compare. */
  diffCurrentPath: "",
  /** Set by the differ mock: the top-mask policy it was passed. */
  diffTopMask: "" as "" | NonNullable<DiffPngFilesOptions["topMask"]>,
  /** Set by the differ mock: the normalizeSizes option it was passed. */
  diffNormalizeSizes: undefined as boolean | undefined,
  /** What the waitForFrame mock resolves a cropOn selector to. */
  cropFrame: undefined as
    | undefined
    | "aborted"
    | { x: number; y: number; width: number; height: number },
  dimensionMismatch: null as null | {
    expected: { width: number; height: number };
    actual: { width: number; height: number };
  },
}));

vi.mock("../../src/tools/flows/flow-actions", async (importOriginal) => ({
  // The real offscreenHint: cropOn failures must surface the directives'
  // standard not-found reason, so the tests assert against the real text.
  offscreenHint: (await importOriginal<typeof import("../../src/tools/flows/flow-actions")>())
    .offscreenHint,
  settleTree: vi.fn(async () => ({})),
  invokeOnDevice: vi.fn(async () => ({ image: { hostPath: h.shotPath } })),
  waitForFrame: vi.fn(async () => h.cropFrame),
}));

vi.mock("../../src/tools/screenshot-diff/screenshot-diff", async (importOriginal) => ({
  // The real band constant: runSnapshot derives the crop top mask from it.
  DEFAULT_IGNORE_TOP_NORMALIZED_Y: (
    await importOriginal<typeof import("../../src/tools/screenshot-diff/screenshot-diff")>()
  ).DEFAULT_IGNORE_TOP_NORMALIZED_Y,
  diffPngFiles: vi.fn(async (options: DiffPngFilesOptions) => {
    h.outputDir = options.outputDir;
    h.diffCurrentPath = options.currentPath;
    h.diffTopMask = options.topMask ?? "status-bar";
    h.diffNormalizeSizes = options.normalizeSizes;
    // The real differ bails before writing anything on a dimension mismatch.
    if (h.dimensionMismatch) {
      return { mismatchPercentage: 0, dimensionMismatch: h.dimensionMismatch };
    }
    // Emulate the real differ: the full-res diff always lands in outputDir,
    // the downscaled context diff only when a test asks for one.
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(options.outputDir, "shot-diff.png"), Buffer.alloc(4));
    let contextDiffPath: string | undefined;
    if (h.writeContextDiff) {
      contextDiffPath = join(options.outputDir, "shot-context-diff.png");
      await writeFile(contextDiffPath, Buffer.alloc(4));
      h.contextDiffPath = contextDiffPath;
    }
    return { mismatchPercentage: h.mismatchPercentage, contextDiffPath };
  }),
}));

const env = {
  device: { platform: "ios", id: "SIM" },
  signal: undefined,
  ctx: { artifacts: new ArtifactStore() },
} as unknown as ActionEnv;

let tmpDir: string;

/** Minimal PNG stand-in: runSnapshot reads only the IHDR width/height bytes. */
async function writeFakePng(file: string, w = 390, h_ = 844): Promise<void> {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h_, 20);
  await fs.writeFile(file, buf);
}

/** Real PNG for the cropOn tests — the crop decodes actual pixel data. */
async function writeRealPng(file: string, w: number, h_: number): Promise<void> {
  const png = new PNG({ width: w, height: h_ });
  png.data.fill(128);
  await fs.writeFile(file, PNG.sync.write(png));
}

async function pngSize(file: string): Promise<{ w: number; h: number }> {
  const png = PNG.sync.read(await fs.readFile(file));
  return { w: png.width, h: png.height };
}

function opts(overrides: Partial<Parameters<typeof runSnapshot>[1]> = {}) {
  return {
    flowsDir: tmpDir,
    flowName: "checkout",
    name: "home",
    maxMismatch: 0.5,
    updateBaselines: false,
    ...overrides,
  };
}

const baselinePath = () => path.join(tmpDir, "__baselines__", "checkout", "home__ios-390x844.png");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-visual-"));
  h.shotPath = path.join(tmpDir, "shot.png");
  h.mismatchPercentage = 0;
  h.writeContextDiff = false;
  h.contextDiffPath = "";
  h.outputDir = "";
  h.diffCurrentPath = "";
  h.diffTopMask = "";
  h.diffNormalizeSizes = undefined;
  h.cropFrame = undefined;
  h.dimensionMismatch = null;
  await writeFakePng(h.shotPath);
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runSnapshot baselines", () => {
  it("fails a missing baseline without seeding one", async () => {
    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    expect(r.reason).toContain('no baseline for "home"');
    expect(r.reason).toContain("--update-baselines");
    // Nothing written: seeding on failure would make this unreviewed capture
    // the truth a re-run silently passes against.
    await expect(fs.access(baselinePath())).rejects.toThrow();
    expect(r.artifacts?.current).toMatchObject({ hostPath: h.shotPath });
    expect(r.artifacts?.baseline).toBeUndefined();
  });

  it("writes a missing baseline and passes under updateBaselines", async () => {
    const r = await runSnapshot(env, opts({ updateBaselines: true }));

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("baseline written");
    await expect(fs.access(baselinePath())).resolves.toBeUndefined();
    // The baseline travels as an artifact handle, not a raw host path.
    expect(r.artifacts?.baseline).toMatchObject({
      __argentArtifact: true,
      hostPath: baselinePath(),
      mimeType: "image/png",
    });
    // Full-screen keys carry no `-crop-` suffix — that is cropOn-only identity.
    expect(r.snapshotKey).toBe("home__ios-390x844");
    expect(r.snapshotKey).not.toContain("-crop-");
  });

  it("refreshes an existing baseline under updateBaselines", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());

    const r = await runSnapshot(env, opts({ updateBaselines: true }));

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("baseline updated");
  });

  it("diffs against an existing baseline", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("diff 0.00%");
    expect(h.diffTopMask).toBe("status-bar");
    // Full-screen keeps the differ's default scale normalization (NOT false).
    expect(h.diffNormalizeSizes).toBeUndefined();
    // A clean pass carries no artifacts — there is nothing to look at, and
    // handles would make renderers fetch two full-res PNGs just to print paths.
    expect(r.artifacts).toBeUndefined();
    expect(r.snapshotKey).toBeUndefined();
  });

  it("fails a dimension-mismatch bail instead of passing its 0% mismatch", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());
    // Full-screen keeps scale normalization, so the real differ only bails on a
    // genuinely different aspect ratio — e.g. a rotated baseline vs the capture.
    h.dimensionMismatch = {
      expected: { width: 844, height: 390 },
      actual: { width: 390, height: 844 },
    };

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("844x390");
    expect(r.reason).toContain("390x844");
    expect(r.reason).toContain("nothing was compared");
    expect(r.artifacts?.baseline).toMatchObject({ __argentArtifact: true });
    expect(r.artifacts?.current).toMatchObject({ hostPath: h.shotPath });
  });

  it("fails an over-threshold diff and exposes the context diff as an artifact", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());
    h.mismatchPercentage = 3.1;
    h.writeContextDiff = true;

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("diff 3.10% > 0.5%");
    // The key an exporter (CLI --output) names the three roles by.
    expect(r.snapshotKey).toBe("home__ios-390x844");
    expect(r.artifacts?.baseline).toMatchObject({ __argentArtifact: true });
    expect(r.artifacts?.current).toMatchObject({ hostPath: h.shotPath });
    expect(r.artifacts?.diff).toMatchObject({
      __argentArtifact: true,
      hostPath: h.contextDiffPath,
      filename: "home__ios-390x844-diff.png",
    });
  });

  it("fails without a diff artifact when the differ produced no context image", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());
    h.mismatchPercentage = 100;

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    expect(r.artifacts?.baseline).toMatchObject({ __argentArtifact: true });
    expect(r.artifacts?.current).toMatchObject({ hostPath: h.shotPath });
    expect(r.artifacts?.diff).toBeUndefined();
  });
});

describe("runSnapshot settle", () => {
  it("proceeds to capture when the tree source is down", async () => {
    // settleTree throws when every read in its window failed (native devtools
    // disconnected). The capture reads pixels, not the tree — the snapshot
    // must still capture and compare instead of reporting an error.
    vi.mocked(settleTree).mockRejectedValueOnce(new Error("native devtools is unavailable"));
    vi.mocked(invokeOnDevice).mockClear();
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("pass");
    expect(vi.mocked(invokeOnDevice)).toHaveBeenCalledWith(env, "screenshot", expect.anything());
  });

  it("skips without capturing when the run was aborted during settle", async () => {
    vi.mocked(settleTree).mockResolvedValueOnce(undefined);
    vi.mocked(invokeOnDevice).mockClear();
    const abortedEnv = { ...env, signal: { aborted: true } } as unknown as ActionEnv;

    const r = await runSnapshot(abortedEnv, opts());

    expect(r.status).toBe("skip");
    expect(r.reason).toContain("aborted");
    expect(vi.mocked(invokeOnDevice)).not.toHaveBeenCalled();
  });
});

describe("runSnapshot diff-dir cleanup", () => {
  const seedBaseline = async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());
  };

  it("removes the whole scratch dir on a within-tolerance pass", async () => {
    await seedBaseline();
    h.writeContextDiff = true; // the real differ writes both files even on a pass

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("pass");
    expect(h.outputDir).not.toBe("");
    await expect(fs.access(h.outputDir)).rejects.toThrow();
  });

  it("keeps only the registered context diff on failure", async () => {
    await seedBaseline();
    h.mismatchPercentage = 3.1;
    h.writeContextDiff = true;

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    // The registered artifact's host path must survive for materialization…
    await expect(fs.access(h.contextDiffPath)).resolves.toBeUndefined();
    // …and it is the only leftover — the unregistered full-res diff is gone.
    await expect(fs.readdir(h.outputDir)).resolves.toEqual([path.basename(h.contextDiffPath)]);
  });

  it("removes the scratch dir when a failure produced no context diff", async () => {
    await seedBaseline();
    h.mismatchPercentage = 100;

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    await expect(fs.access(h.outputDir)).rejects.toThrow();
  });

  it("removes the scratch dir on a dimension-mismatch bail", async () => {
    await seedBaseline();
    // Aspect ratios must genuinely differ for a full-screen bail (see above).
    h.dimensionMismatch = {
      expected: { width: 844, height: 390 },
      actual: { width: 390, height: 844 },
    };

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    await expect(fs.access(h.outputDir)).rejects.toThrow();
  });
});

describe("runSnapshot cropOn", () => {
  const cropOn = { text: "Header", loose: true };
  // A cropOn key = full-capture dims + hash of the canonical selector identity
  // ([text, textMatches, identifier, role, loose]) — recomputed here
  // independently to pin the on-disk format.
  const cropKey = `home__ios-100x200-crop-${createHash("sha256")
    .update(JSON.stringify(["Header", null, null, null, true]))
    .digest("hex")
    .slice(0, 8)}`;
  // 100×200 capture; the frame's pixel rect is x 25–75, y 50–100 → a 50×50 crop.
  const frame = { x: 0.25, y: 0.25, width: 0.5, height: 0.25 };
  const cropBaselinePath = () => path.join(tmpDir, "__baselines__", "checkout", `${cropKey}.png`);

  beforeEach(async () => {
    await writeRealPng(h.shotPath, 100, 200);
    h.cropFrame = frame;
  });

  it("stores the cropped region as the baseline, keyed by the full capture", async () => {
    vi.mocked(settleTree).mockClear();

    const r = await runSnapshot(env, opts({ updateBaselines: true, cropOn }));

    expect(r.status).toBe("pass");
    expect(vi.mocked(waitForFrame)).toHaveBeenCalledWith(env, cropOn);
    // waitForFrame settles internally — the plain settle must not run too.
    expect(vi.mocked(settleTree)).not.toHaveBeenCalled();
    // Key: the FULL capture's dimensions (device-class identity) plus the
    // selector hash (crop identity). Content: the crop.
    expect(r.snapshotKey).toBe(cropKey);
    await expect(pngSize(cropBaselinePath())).resolves.toEqual({ w: 50, h: 50 });
  });

  it("compares the cropped image and sweeps the crop scratch dir on a pass", async () => {
    await fs.mkdir(path.dirname(cropBaselinePath()), { recursive: true });
    await writeRealPng(cropBaselinePath(), 50, 50);

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("pass");
    // The differ compared the cropped scratch file, not the full capture…
    expect(h.diffCurrentPath).not.toBe(h.shotPath);
    expect(path.basename(h.diffCurrentPath)).toBe(`${cropKey}.png`);
    // A crop fully below the status-bar band (y ≥ 0.06) gets no top mask —
    // its top is element content, not the full screen's status bar.
    expect(h.diffTopMask).toBe("none");
    // Crop dims carry meaning — the differ must hard-fail any size drift.
    expect(h.diffNormalizeSizes).toBe(false);
    // …and the unregistered crop did not outlive the call.
    await expect(fs.access(path.dirname(h.diffCurrentPath))).rejects.toThrow();
  });

  it("masks the crop's overlap with the screen's status-bar band", async () => {
    // y 0.02–0.10 overlaps the top band (0–0.06) by 0.04 — half the crop's
    // 0.08 height. On the 100×200 capture that crop is 50×16 pixels.
    h.cropFrame = { x: 0, y: 0.02, width: 0.5, height: 0.08 };
    await fs.mkdir(path.dirname(cropBaselinePath()), { recursive: true });
    await writeRealPng(cropBaselinePath(), 50, 16);

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("pass");
    expect(h.diffTopMask).toHaveProperty("topFraction");
    expect((h.diffTopMask as { topFraction: number }).topFraction).toBeCloseTo(0.5);
  });

  it("returns the cropped image as `current` on a missing baseline", async () => {
    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("fail");
    expect(r.reason).toContain('no baseline for "home"');
    const current = r.artifacts?.current as { hostPath: string };
    expect(current.hostPath).not.toBe(h.shotPath);
    // The artifact is what would have been compared — the crop, kept alive
    // past the scratch-dir sweep for later materialization.
    await expect(pngSize(current.hostPath)).resolves.toEqual({ w: 50, h: 50 });
  });

  it("keeps only the registered cropped `current` on an over-threshold failure", async () => {
    await fs.mkdir(path.dirname(cropBaselinePath()), { recursive: true });
    await writeRealPng(cropBaselinePath(), 50, 50);
    h.mismatchPercentage = 3.1;

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("fail");
    const current = r.artifacts?.current as { hostPath: string };
    await expect(pngSize(current.hostPath)).resolves.toEqual({ w: 50, h: 50 });
    await expect(fs.readdir(path.dirname(current.hostPath))).resolves.toEqual([`${cropKey}.png`]);
  });

  it("fails with the standard not-found reason without capturing when cropOn never resolves", async () => {
    h.cropFrame = undefined;
    vi.mocked(invokeOnDevice).mockClear();

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("fail");
    expect(r.reason).toContain('no visible element matched selector text="Header"');
    expect(r.reason).toContain("scroll-to");
    expect(vi.mocked(invokeOnDevice)).not.toHaveBeenCalled();
  });

  it("skips without capturing when the run is aborted while resolving cropOn", async () => {
    h.cropFrame = "aborted";
    vi.mocked(invokeOnDevice).mockClear();

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("skip");
    expect(r.reason).toContain("aborted");
    expect(vi.mocked(invokeOnDevice)).not.toHaveBeenCalled();
  });

  it("names element-size drift on a dimension-mismatch bail", async () => {
    await fs.mkdir(path.dirname(cropBaselinePath()), { recursive: true });
    await writeRealPng(cropBaselinePath(), 50, 60);
    h.dimensionMismatch = {
      expected: { width: 50, height: 60 },
      actual: { width: 50, height: 50 },
    };

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("cropOn region is 50x50");
    expect(r.reason).toContain("crop a fixed-size container");
  });

  it("fails a sub-pixel crop region instead of writing an empty PNG", async () => {
    h.cropFrame = { x: 0.5, y: 0.5, width: 0.001, height: 0.001 };
    const preexistingCropDirs = new Set(
      (await fs.readdir(os.tmpdir())).filter((e) => e.startsWith("argent-flow-crop-"))
    );

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("empty at this resolution");
    // The key still names the failure for an exporter (CLI --output), and the
    // FULL capture is attached as `current` — no crop exists to show.
    expect(r.snapshotKey).toBe(cropKey);
    expect(r.artifacts?.current).toMatchObject({ hostPath: h.shotPath });
    // The crop scratch dir (which never received a file) was swept.
    const leftoverCropDirs = (await fs.readdir(os.tmpdir())).filter(
      (e) => e.startsWith("argent-flow-crop-") && !preexistingCropDirs.has(e)
    );
    expect(leftoverCropDirs).toEqual([]);
  });

  it("keys same-name snapshots with different cropOn selectors to distinct baselines", async () => {
    const r1 = await runSnapshot(env, opts({ updateBaselines: true, cropOn: { text: "Header" } }));
    const r2 = await runSnapshot(
      env,
      opts({ updateBaselines: true, cropOn: { identifier: "hdr" } })
    );

    expect(r1.snapshotKey).toContain("-crop-");
    expect(r2.snapshotKey).toContain("-crop-");
    expect(r1.snapshotKey).not.toBe(r2.snapshotKey);
    // Two baseline files on disk — the second write did not clobber the first.
    const files = await fs.readdir(path.join(tmpDir, "__baselines__", "checkout"));
    expect(files.sort()).toEqual([`${r1.snapshotKey}.png`, `${r2.snapshotKey}.png`].sort());
  });

  it("keys a selector canonically regardless of property insertion order", async () => {
    const r1 = await runSnapshot(
      env,
      opts({ updateBaselines: true, cropOn: { text: "a", role: "b" } })
    );
    const r2 = await runSnapshot(
      env,
      opts({ updateBaselines: true, cropOn: { role: "b", text: "a" } })
    );

    expect(r1.snapshotKey).toBe(r2.snapshotKey);
  });

  it("keys loose and strict spellings of the same text differently", async () => {
    // `loose` changes resolution (identifier-first fallback) — a different element.
    const r1 = await runSnapshot(
      env,
      opts({ updateBaselines: true, cropOn: { text: "foo", loose: true } })
    );
    const r2 = await runSnapshot(env, opts({ updateBaselines: true, cropOn: { text: "foo" } }));

    expect(r1.snapshotKey).not.toBe(r2.snapshotKey);
  });
});
