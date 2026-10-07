import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import { runSnapshot } from "../../src/tools/flows/flow-visual";
import {
  HostProjectAccess,
  type ProjectAccess,
  type ResolvedFlowFile,
} from "../../src/tools/flows/project-access";
import { ArtifactStore } from "../../src/artifacts";
import {
  diffPngFiles,
  type DiffPngFilesOptions,
} from "../../src/tools/screenshot-diff/screenshot-diff";
import {
  settleTree,
  invokeOnDevice,
  waitForFrame,
  type ActionEnv,
} from "../../src/tools/flows/flow-actions";
import { redirectTmpdir } from "../helpers/tmpdir-env";

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
  /** Set by the differ mock: the baselinePath it was asked to compare. */
  diffBaselinePath: "",
  /**
   * Set by the differ mock: that file's bytes, read during the call — a client
   * baseline's server copy is swept before a test could read it.
   */
  diffBaselineBytes: null as null | Buffer,
  /** What the waitForFrame mock resolves a cropOn selector to. */
  cropFrame: undefined as
    | undefined
    | "aborted"
    | { x: number; y: number; width: number; height: number },
  /** When set, the waitForFrame mock rejects with this (a tree-source outage). */
  cropFrameError: null as null | Error,
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
  waitForFrame: vi.fn(async () => {
    if (h.cropFrameError) throw h.cropFrameError;
    return h.cropFrame;
  }),
}));

vi.mock("../../src/tools/screenshot-diff/screenshot-diff", () => ({
  diffPngFiles: vi.fn(async (options: DiffPngFilesOptions) => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    h.outputDir = options.outputDir;
    h.diffCurrentPath = options.currentPath;
    h.diffTopMask = options.topMask ?? "status-bar";
    h.diffNormalizeSizes = options.normalizeSizes;
    h.diffBaselinePath = options.baselinePath;
    // Like the real differ, which reads the baseline before anything else.
    h.diffBaselineBytes = await readFile(options.baselinePath);
    // The real differ bails before writing anything on a dimension mismatch.
    if (h.dimensionMismatch) {
      return { mismatchPercentage: 0, dimensionMismatch: h.dimensionMismatch };
    }
    // Emulate the real differ: the full-res diff always lands in outputDir,
    // the downscaled context diff only when a test asks for one.
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

/** The same simulator model, reached over sim-remote instead of locally. */
const remoteEnv = {
  device: { platform: "ios-remote", id: "remote:SIM" },
  signal: undefined,
  ctx: { artifacts: new ArtifactStore() },
} as unknown as ActionEnv;

let tmpDir = "";
let osTmpdir: string;
let restoreTmpdir: () => void = () => {};

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

/**
 * Coordinate-encoded PNG: every pixel's channels name its own position
 * (r = x, g = y, b = x + y), so a test can assert exactly WHICH region of the
 * capture a crop contains — a transposed or shifted rect carries the wrong
 * coordinates, where a uniform fill would make wrong pixels look right.
 */
async function writeCoordPng(file: string, w: number, h_: number): Promise<void> {
  const png = new PNG({ width: w, height: h_ });
  for (let y = 0; y < h_; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      png.data[i] = x & 0xff;
      png.data[i + 1] = y & 0xff;
      png.data[i + 2] = (x + y) & 0xff;
      png.data[i + 3] = 255;
    }
  }
  await fs.writeFile(file, PNG.sync.write(png));
}

async function pngPixel(file: string, x: number, y: number): Promise<[number, number, number]> {
  const png = PNG.sync.read(await fs.readFile(file));
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

function opts(overrides: Partial<Parameters<typeof runSnapshot>[1]> = {}) {
  return {
    flowsDir: tmpDir,
    flowName: "checkout",
    name: "home",
    maxMismatch: 0.5,
    updateBaselines: false,
    appIdentity: "/apps/app-a",
    seenKeys: new Map<string, string>(),
    project: new HostProjectAccess(),
    ...overrides,
  };
}

const baselinePath = () => path.join(tmpDir, "__baselines__", "checkout", "home__ios-390x844.png");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-visual-"));
  // runSnapshot mkdtemps its crop and diff scratch dirs under os.tmpdir() and
  // deliberately leaves whichever file it registered as an artifact in place —
  // from there the dir belongs to whoever consumes the artifact. Here that is
  // the test, so os.tmpdir() points inside tmpDir and the sweep below takes it.
  osTmpdir = path.join(tmpDir, "os-tmpdir");
  await fs.mkdir(osTmpdir);
  restoreTmpdir = redirectTmpdir(osTmpdir);
  h.shotPath = path.join(tmpDir, "shot.png");
  h.mismatchPercentage = 0;
  h.writeContextDiff = false;
  h.contextDiffPath = "";
  h.outputDir = "";
  h.diffCurrentPath = "";
  h.diffTopMask = "";
  h.diffNormalizeSizes = undefined;
  h.diffBaselinePath = "";
  h.diffBaselineBytes = null;
  h.cropFrame = undefined;
  h.cropFrameError = null;
  h.dimensionMismatch = null;
  await writeFakePng(h.shotPath);
});
afterEach(async () => {
  restoreTmpdir();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runSnapshot baselines", () => {
  it("carries the capture's warning, and none without one", async () => {
    // A foldable whose panel could not be resolved: the screenshot tool warns,
    // and the step owes that to the report on whatever outcome it reaches.
    const warning = "The panel this foldable simulator renders to could not be resolved (…)";
    vi.mocked(invokeOnDevice).mockResolvedValueOnce({ image: { hostPath: h.shotPath }, warning });
    const warned = await runSnapshot(env, opts({ updateBaselines: true }));
    expect(warned.status).toBe("pass");
    expect(warned.warning).toBe(warning);

    const plain = await runSnapshot(env, opts());
    expect(plain).not.toHaveProperty("warning");
  });

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
      kind: "screenshot",
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

  it("refreshes a baseline this process can write but not read", async () => {
    // Only whether a baseline is there decides "updated": its bytes are not read.
    if (process.getuid?.() === 0) return;
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());
    await fs.chmod(baselinePath(), 0o200);

    const r = await runSnapshot(env, opts({ updateBaselines: true }));

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("baseline updated");
  });

  it("fails as a missing baseline when a file stands where its directory should be", async () => {
    await fs.mkdir(path.dirname(path.dirname(baselinePath())), { recursive: true });
    await fs.writeFile(path.dirname(baselinePath()), "not a directory");

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    expect(r.reason).toContain('no baseline for "home"');
  });

  it("reports a baseline path it cannot read as an error, not as a missing baseline", async () => {
    // "No baseline" would steer the author to adopt the current screen.
    await fs.mkdir(baselinePath(), { recursive: true });

    const err = await runSnapshot(env, opts()).catch((e: unknown) => e);

    // The read error alone does not name the file it hit, so the step does.
    expect((err as Error).message).toMatch(/EISDIR/);
    const prefix = `Could not read PNG at ${baselinePath()}: `;
    expect((err as Error).message.slice(0, prefix.length)).toBe(prefix);
    expect((err as Error & { cause?: unknown }).cause).toMatchObject({ code: "EISDIR" });
  });

  it("names an unreadable baseline once when the read error names it already", async () => {
    if (process.getuid?.() === 0) return;
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());
    await fs.chmod(baselinePath(), 0o000);

    const err = await runSnapshot(env, opts()).catch((e: unknown) => e);

    expect((err as { code?: unknown }).code).toBe("EACCES");
    expect((err as Error).message.split(baselinePath())).toHaveLength(2);
  });

  it("names the baseline file when it does not decode", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/tools/screenshot-diff/screenshot-diff")
    >("../../src/tools/screenshot-diff/screenshot-diff");
    vi.mocked(diffPngFiles).mockImplementationOnce(actual.diffPngFiles);
    await writeRealPng(h.shotPath, 390, 844);
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await fs.writeFile(baselinePath(), "version https://git-lfs.github.com/spec/v1\n");

    const err = await runSnapshot(env, opts()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FailureError);
    const prefix = `Could not read PNG at ${baselinePath()}: `;
    expect((err as Error).message.slice(0, prefix.length)).toBe(prefix);
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
      kind: "screenshot-diff-context",
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

describe("runSnapshot cross-app key collision", () => {
  // The run already captured this key from another app — flow-run's seenKeys
  // record, pre-seeded the way a prior snapshot step would leave it.
  const seenFromAppB = () => new Map([["home__ios-390x844", "/apps/app-b"]]);

  it("fails a key already captured from a different app instead of overwriting its baseline", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await fs.writeFile(baselinePath(), Buffer.from("app-b pixels"));

    const r = await runSnapshot(env, opts({ updateBaselines: true, seenKeys: seenFromAppB() }));

    expect(r.status).toBe("fail");
    expect(r.reason).toContain(
      'snapshot "home" was already captured in this run from a different app (/apps/app-b)'
    );
    expect(r.reason).toContain("home__ios-390x844.png");
    expect(r.reason).toContain("distinct names");
    expect(r.snapshotKey).toBe("home__ios-390x844");
    // The other app's baseline survived — updateBaselines wrote nothing.
    await expect(fs.readFile(baselinePath(), "utf8")).resolves.toBe("app-b pixels");
  });

  it("fails before comparing anything in plain compare mode", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());
    vi.mocked(diffPngFiles).mockClear();

    const r = await runSnapshot(env, opts({ seenKeys: seenFromAppB() }));

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("already captured in this run from a different app");
    expect(vi.mocked(diffPngFiles)).not.toHaveBeenCalled();
  });

  it("allows recapturing a key from the same app", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());

    const r = await runSnapshot(
      env,
      opts({ seenKeys: new Map([["home__ios-390x844", "/apps/app-a"]]) })
    );

    expect(r.status).toBe("pass");
  });
});

describe("runSnapshot settle", () => {
  it("proceeds to capture when the tree source is down", async () => {
    // settleTree throws when every read attempt failed (native devtools
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
    // The artifact is the baseline file itself, so the crop scratch dir goes.
    expect(r.artifacts?.baseline).toMatchObject({ hostPath: cropBaselinePath() });
    await expect(fs.readdir(osTmpdir)).resolves.toEqual([]);
  });

  it("compares the cropped image and sweeps the crop scratch dir on a pass", async () => {
    await fs.mkdir(path.dirname(cropBaselinePath()), { recursive: true });
    await writeRealPng(cropBaselinePath(), 50, 50);

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("pass");
    // The differ compared the cropped scratch file, not the full capture…
    expect(h.diffCurrentPath).not.toBe(h.shotPath);
    expect(path.basename(h.diffCurrentPath)).toBe(`${cropKey}.png`);
    // Crops are never top-masked — the top of a crop is element content, not
    // the full screen's status bar.
    expect(h.diffTopMask).toBe("none");
    // Crop dims carry meaning — the differ must hard-fail any size drift.
    expect(h.diffNormalizeSizes).toBe(false);
    // …and the unregistered crop did not outlive the call.
    await expect(fs.access(path.dirname(h.diffCurrentPath))).rejects.toThrow();
  });

  it("never masks a crop, even one overlapping the status-bar band", async () => {
    // y 0.02–0.10 overlaps the top band — but masking a crop's overlap would
    // degenerate into comparing NOTHING for an element fully inside the band
    // (a vacuous pass), so a crop compares every pixel wherever it sits.
    h.cropFrame = { x: 0, y: 0.02, width: 0.5, height: 0.08 };
    await fs.mkdir(path.dirname(cropBaselinePath()), { recursive: true });
    await writeRealPng(cropBaselinePath(), 50, 16);

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("pass");
    expect(h.diffTopMask).toBe("none");
  });

  it("crops exactly the frame's pixel rect from the capture", async () => {
    await writeCoordPng(h.shotPath, 100, 200);

    const r = await runSnapshot(env, opts({ updateBaselines: true, cropOn }));

    expect(r.status).toBe("pass");
    // frame {x: 0.25, y: 0.25, w: 0.5, h: 0.25} on 100×200 → rect x 25–75,
    // y 50–100. The corner pixels' coordinate encoding pins the exact rect.
    await expect(pngPixel(cropBaselinePath(), 0, 0)).resolves.toEqual([25, 50, 75]);
    await expect(pngPixel(cropBaselinePath(), 49, 0)).resolves.toEqual([74, 50, 124]);
    await expect(pngPixel(cropBaselinePath(), 0, 49)).resolves.toEqual([25, 99, 124]);
    await expect(pngPixel(cropBaselinePath(), 49, 49)).resolves.toEqual([74, 99, 173]);
  });

  it("propagates a tree-source outage while resolving cropOn as an error", async () => {
    // Deliberate asymmetry with the full-screen path's swallowed settle
    // outage: without a tree there is no frame, and degrading to a full-screen
    // capture would "compare" the whole screen against a cropped baseline.
    // flow-run's snapshot arm turns the throw into a step error.
    h.cropFrameError = new Error("native devtools disconnected");
    vi.mocked(invokeOnDevice).mockClear();

    await expect(runSnapshot(env, opts({ cropOn }))).rejects.toThrow(
      "native devtools disconnected"
    );
    // Failed before capturing — no screenshot was taken.
    expect(vi.mocked(invokeOnDevice)).not.toHaveBeenCalled();
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
    const current = r.artifacts?.current as { hostPath: string; filename: string };
    await expect(pngSize(current.hostPath)).resolves.toEqual({ w: 50, h: 50 });
    await expect(fs.readdir(path.dirname(current.hostPath))).resolves.toEqual([`${cropKey}.png`]);
    // The crop file on disk shares the baseline's basename, and a remote client
    // materializes downloads by filename — the two handles must not collide.
    expect(current.filename).toBe(`${cropKey}-current.png`);
    expect(r.artifacts?.baseline).toMatchObject({ filename: `${cropKey}.png` });
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
    // Same collision risk as the over-threshold path: both handles download.
    expect(r.artifacts?.current).toMatchObject({ filename: `${cropKey}-current.png` });
    expect(r.artifacts?.baseline).toMatchObject({ filename: `${cropKey}.png` });
  });

  it("fails a sub-pixel crop region instead of writing an empty PNG", async () => {
    h.cropFrame = { x: 0.5, y: 0.5, width: 0.001, height: 0.001 };
    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("empty at this resolution");
    // The key still names the failure for an exporter (CLI --output), and the
    // FULL capture is attached as `current` — no crop exists to show.
    expect(r.snapshotKey).toBe(cropKey);
    expect(r.artifacts?.current).toMatchObject({ hostPath: h.shotPath });
    // The crop scratch dir (which never received a file) was swept. os.tmpdir()
    // is this test's own, so the listing shows this run's crop dirs and nothing
    // a concurrent run left in flight.
    const leftoverCropDirs = (await fs.readdir(osTmpdir)).filter((e) =>
      e.startsWith("argent-flow-crop-")
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

  it("keys same-name crops that differ only by scope to distinct baselines", async () => {
    const r1 = await runSnapshot(
      env,
      opts({ updateBaselines: true, cropOn: { text: "Toggle", within: { identifier: "row-1" } } })
    );
    const r2 = await runSnapshot(
      env,
      opts({ updateBaselines: true, cropOn: { text: "Toggle", within: { identifier: "row-2" } } })
    );

    expect(r1.snapshotKey).not.toBe(r2.snapshotKey);
    // Two baseline files on disk — row-2 did not overwrite row-1's baseline.
    const files = await fs.readdir(path.join(tmpDir, "__baselines__", "checkout"));
    expect(files.sort()).toEqual([`${r1.snapshotKey}.png`, `${r2.snapshotKey}.png`].sort());
  });

  it("keys the same scope reached through different relations apart", async () => {
    const r1 = await runSnapshot(
      env,
      opts({ updateBaselines: true, cropOn: { text: "Toggle", after: { identifier: "row" } } })
    );
    const r2 = await runSnapshot(
      env,
      opts({ updateBaselines: true, cropOn: { text: "Toggle", next: { identifier: "row" } } })
    );

    expect(r1.snapshotKey).not.toBe(r2.snapshotKey);
  });

  it("keys an unscoped selector by its own fields alone", async () => {
    // Committed baselines predate scope-aware keys; adding a scope must not
    // rename the file an unscoped crop already writes.
    const r = await runSnapshot(env, opts({ updateBaselines: true, cropOn }));

    expect(r.snapshotKey).toBe(cropKey);
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

  it("fails a crop key recaptured from another app, like any other key", async () => {
    const seenKeys = new Map<string, string>();

    const r1 = await runSnapshot(env, opts({ updateBaselines: true, cropOn, seenKeys }));
    const r2 = await runSnapshot(
      env,
      opts({ updateBaselines: true, cropOn, seenKeys, appIdentity: "/apps/app-b" })
    );

    expect(r1.status).toBe("pass");
    expect(r2.status).toBe("fail");
    expect(r2.reason).toContain("already captured in this run from a different app (/apps/app-a)");
    expect(r2.reason).toContain(`${cropKey}.png`);
    // One file on disk: app-b never wrote over app-a's crop.
    const files = await fs.readdir(path.join(tmpDir, "__baselines__", "checkout"));
    expect(files).toEqual([`${cropKey}.png`]);
  });

  it("lets two apps share a snapshot name when they crop different elements", async () => {
    // The keys carry the selector, so the two never share a baseline file —
    // a guard keyed on the snapshot NAME would wrongly reject this.
    const seenKeys = new Map<string, string>();

    const r1 = await runSnapshot(
      env,
      opts({ updateBaselines: true, cropOn: { text: "Header" }, seenKeys })
    );
    const r2 = await runSnapshot(
      env,
      opts({
        updateBaselines: true,
        cropOn: { identifier: "hdr" },
        seenKeys,
        appIdentity: "/apps/app-b",
      })
    );

    expect(r1.status).toBe("pass");
    expect(r2.status).toBe("pass");
    expect(r1.snapshotKey).not.toBe(r2.snapshotKey);
    const files = await fs.readdir(path.join(tmpDir, "__baselines__", "checkout"));
    expect(files.sort()).toEqual([`${r1.snapshotKey}.png`, `${r2.snapshotKey}.png`].sort());
  });
});

describe("runSnapshot on a remote simulator", () => {
  it("matches the baseline a local run of the same device class committed", async () => {
    // The key names a device class, not a host: a cloud run must compare
    // against the committed baseline instead of failing as if none existed,
    // which would force every baseline to be captured and reviewed twice.
    const seeded = await runSnapshot(env, opts({ updateBaselines: true }));
    expect(seeded.snapshotKey).toBe("home__ios-390x844");

    const r = await runSnapshot(remoteEnv, opts());

    expect(r.status).toBe("pass");
    // A clean pass carries no key or artifacts, so the reason names the file
    // that was actually compared: the one the local run wrote.
    expect(r.reason).toContain("home__ios-390x844.png");
    // One file: the remote run neither wrote nor demanded an `ios-remote` copy.
    const files = await fs.readdir(path.join(tmpDir, "__baselines__", "checkout"));
    expect(files).toEqual(["home__ios-390x844.png"]);
  });

  it("rewrites the local baseline in place under updateBaselines, and says so", async () => {
    // The fold works in the write direction too: a remote refresh replaces the
    // file a local run seeded instead of writing a copy beside it, so the
    // reason is the only place the report shows a cloud capture took over.
    const local = await runSnapshot(env, opts({ updateBaselines: true }));
    expect(local.reason).toBe("baseline written (home__ios-390x844.png)");
    const seeded = await fs.readFile(baselinePath());

    // Same IHDR, so the same key; the trailing bytes make the capture distinct.
    await fs.writeFile(h.shotPath, Buffer.concat([seeded, Buffer.from("remote capture")]));
    const remote = await runSnapshot(remoteEnv, opts({ updateBaselines: true }));

    expect(remote.status).toBe("pass");
    expect(remote.snapshotKey).toBe(local.snapshotKey);
    expect(remote.reason).toBe("baseline updated from a remote simulator (home__ios-390x844.png)");
    const rewritten = await fs.readFile(baselinePath());
    expect(rewritten).not.toEqual(seeded);
    expect(rewritten).toEqual(await fs.readFile(h.shotPath));
    const files = await fs.readdir(path.join(tmpDir, "__baselines__", "checkout"));
    expect(files).toEqual(["home__ios-390x844.png"]);
  });

  it("keys a crop the same way a local run does", async () => {
    // The fold applies to the whole key, not just its uncropped spelling.
    await writeRealPng(h.shotPath, 100, 200);
    h.cropFrame = { x: 0.25, y: 0.25, width: 0.5, height: 0.25 };
    const cropOn = { text: "Header", loose: true };

    const local = await runSnapshot(env, opts({ updateBaselines: true, cropOn }));
    const remote = await runSnapshot(remoteEnv, opts({ cropOn }));

    expect(local.snapshotKey).toContain("__ios-100x200-crop-");
    expect(remote.status).toBe("pass");
    expect(remote.reason).toContain(`${local.snapshotKey}.png`);
    const files = await fs.readdir(path.join(tmpDir, "__baselines__", "checkout"));
    expect(files).toEqual([`${local.snapshotKey}.png`]);
  });
});

describe("runSnapshot with a client project", () => {
  // An upload over a link: flowsDir is the server temp dir the upload landed
  // in, and the baselines live beside the root flow's real file on the client.
  const clientFlowPath = "/client/proj/.argent/flows/withsnap.yaml";
  const clientBaseline = "/client/proj/.argent/flows/__baselines__/withsnap/home__ios-390x844.png";

  /**
   * The client's side of the channel: answers every read with `stored`, and
   * every write with whether `stored` was there; records reads and writes.
   */
  const clientProject = (stored: Buffer | null) => ({
    mode: "client" as const,
    resolveFlowFile: vi.fn(async (): Promise<ResolvedFlowFile> => {
      throw new Error("unused");
    }),
    readFile: vi.fn(async (_filePath: string): Promise<Buffer | null> => stored),
    writeBaseline: vi.fn(async (_filePath: string, _bytes: Buffer) => ({
      replaced: stored !== null,
    })),
  });

  const clientOpts = (
    project: ProjectAccess,
    overrides: Partial<Parameters<typeof runSnapshot>[1]> = {}
  ) => opts({ flowName: "withsnap", project, clientFlowPath, ...overrides });

  /** os.tmpdir() is this test's own, so these are this run's leftover copies only. */
  const baselineCopyDirs = async () =>
    (await fs.readdir(osTmpdir)).filter((e) => e.startsWith("argent-flow-baseline-"));

  it("reads the baseline from the client and passes on a match", async () => {
    const project = clientProject(await fs.readFile(h.shotPath));

    const r = await runSnapshot(env, clientOpts(project));

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("diff 0.00%");
    expect(project.readFile.mock.calls).toEqual([[clientBaseline]]);
    expect(project.writeBaseline).not.toHaveBeenCalled();
    // The differ compared a server copy under the key filename, not the client path.
    expect(path.dirname(path.dirname(h.diffBaselinePath))).toBe(osTmpdir);
    expect(path.basename(h.diffBaselinePath)).toBe("home__ios-390x844.png");
    expect(h.diffBaselineBytes).toEqual(await fs.readFile(h.shotPath));
  });

  it("fails a missing client baseline without a write", async () => {
    const project = clientProject(null);
    vi.mocked(diffPngFiles).mockClear();

    const r = await runSnapshot(env, clientOpts(project));

    expect(r.status).toBe("fail");
    expect(r.reason).toMatch(/^no baseline for "home"/);
    expect(r.reason).toContain(`expected ${clientBaseline},`);
    expect(project.writeBaseline).not.toHaveBeenCalled();
    expect(vi.mocked(diffPngFiles)).not.toHaveBeenCalled();
    expect(r.artifacts?.current).toMatchObject({ hostPath: h.shotPath });
    expect(r.artifacts?.baseline).toBeUndefined();
    await expect(baselineCopyDirs()).resolves.toEqual([]);
  });

  it("writes the baseline to the client under updateBaselines", async () => {
    const project = clientProject(null);
    const capture = await fs.readFile(h.shotPath);

    const r = await runSnapshot(env, clientOpts(project, { updateBaselines: true }));

    expect(r.status).toBe("pass");
    // The reason names where the client wrote the baseline.
    expect(r.reason).toBe(`baseline written (${clientBaseline})`);
    expect(project.writeBaseline.mock.calls).toEqual([[clientBaseline, capture]]);
    // The write itself says whether a baseline was there: nothing is read.
    expect(project.readFile).not.toHaveBeenCalled();
    // No artifact: every file on this host is scratch, and its path would name
    // the wrong machine as the baseline.
    expect(r.artifacts).toBeUndefined();
    await expect(baselineCopyDirs()).resolves.toEqual([]);
  });

  it("says updated when the client already had a baseline", async () => {
    const project = clientProject(Buffer.from("old pixels"));

    const r = await runSnapshot(env, clientOpts(project, { updateBaselines: true }));

    expect(r.status).toBe("pass");
    expect(r.reason).toBe(`baseline updated (${clientBaseline})`);
    expect(r.artifacts).toBeUndefined();
    expect(project.writeBaseline.mock.calls).toEqual([
      [clientBaseline, await fs.readFile(h.shotPath)],
    ]);
  });

  it("names a remote simulator as the source of a client baseline it wrote", async () => {
    const project = clientProject(Buffer.from("old pixels"));

    const r = await runSnapshot(remoteEnv, clientOpts(project, { updateBaselines: true }));

    expect(r.status).toBe("pass");
    expect(r.reason).toBe(`baseline updated from a remote simulator (${clientBaseline})`);
    expect(r.artifacts).toBeUndefined();
  });

  it("returns the context diff as an artifact on a client mismatch", async () => {
    const stored = Buffer.from("old pixels");
    const project = clientProject(stored);
    h.mismatchPercentage = 3.1;
    h.writeContextDiff = true;

    const r = await runSnapshot(env, clientOpts(project));

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("diff 3.10% > 0.5%");
    expect(project.writeBaseline).not.toHaveBeenCalled();
    // The differ compared the CLIENT's bytes, not anything on the server.
    expect(h.diffBaselineBytes).toEqual(stored);
    expect(r.artifacts?.diff).toMatchObject({
      kind: "screenshot-diff-context",
      hostPath: h.contextDiffPath,
      filename: "home__ios-390x844-diff.png",
    });
    expect(r.artifacts?.current).toMatchObject({ hostPath: h.shotPath });
    const baseline = r.artifacts?.baseline as { hostPath: string; filename: string };
    expect(baseline.filename).toBe("home__ios-390x844.png");
    await expect(fs.readFile(baseline.hostPath)).resolves.toEqual(stored);
  });

  it("stores the cropped region on the client under cropOn", async () => {
    await writeCoordPng(h.shotPath, 100, 200);
    // 100×200 capture; the frame's pixel rect is x 25–75, y 50–100 → a 50×50 crop.
    h.cropFrame = { x: 0.25, y: 0.25, width: 0.5, height: 0.25 };
    const project = clientProject(null);

    const r = await runSnapshot(
      env,
      clientOpts(project, { updateBaselines: true, cropOn: { text: "Header", loose: true } })
    );

    expect(r.status).toBe("pass");
    expect(r.snapshotKey).toMatch(/^home__ios-100x200-crop-[0-9a-f]{8}$/);
    expect(project.writeBaseline).toHaveBeenCalledTimes(1);
    const [written, bytes] = project.writeBaseline.mock.calls[0];
    expect(written).toBe(`/client/proj/.argent/flows/__baselines__/withsnap/${r.snapshotKey}.png`);
    // The crop, not the full capture: its corner pixels encode the frame's rect.
    const png = PNG.sync.read(bytes);
    expect({ w: png.width, h: png.height }).toEqual({ w: 50, h: 50 });
    expect([...png.data.subarray(0, 3)]).toEqual([25, 50, 75]);
    const last = (49 * 50 + 49) * 4;
    expect([...png.data.subarray(last, last + 3)]).toEqual([74, 99, 173]);
    expect(r.reason).toBe(`baseline written (${written})`);
    // The crop is not registered, so the call leaves no scratch file behind.
    expect(r.artifacts).toBeUndefined();
    await expect(fs.readdir(osTmpdir)).resolves.toEqual([]);
  });

  it("keeps the baseline copy it returns on a client dimension mismatch", async () => {
    const stored = Buffer.from("old pixels");
    h.dimensionMismatch = {
      expected: { width: 390, height: 844 },
      actual: { width: 400, height: 844 },
    };

    const r = await runSnapshot(env, clientOpts(clientProject(stored)));

    expect(r.status).toBe("fail");
    const baseline = r.artifacts?.baseline as { hostPath: string };
    await expect(fs.readFile(baseline.hostPath)).resolves.toEqual(stored);
  });

  it("removes the baseline copy on a pass", async () => {
    const project = clientProject(await fs.readFile(h.shotPath));
    h.writeContextDiff = true;

    const r = await runSnapshot(env, clientOpts(project));

    expect(r.status).toBe("pass");
    expect(h.diffBaselinePath).not.toBe("");
    await expect(baselineCopyDirs()).resolves.toEqual([]);
  });

  it("keeps only the registered baseline copy on a failure", async () => {
    const project = clientProject(Buffer.from("old pixels"));
    h.mismatchPercentage = 3.1;

    const r = await runSnapshot(env, clientOpts(project));

    expect(r.status).toBe("fail");
    const baseline = r.artifacts?.baseline as { hostPath: string };
    const copyDirs = await baselineCopyDirs();
    expect(copyDirs).toEqual([path.basename(path.dirname(baseline.hostPath))]);
    await expect(fs.readdir(path.join(osTmpdir, copyDirs[0]))).resolves.toEqual([
      "home__ios-390x844.png",
    ]);
  });

  it("never writes a client baseline on the server", async () => {
    const capture = await fs.readFile(h.shotPath);
    // Every outcome a client baseline reaches: written, updated, matched,
    // mismatched, missing.
    await runSnapshot(env, clientOpts(clientProject(null), { updateBaselines: true }));
    await runSnapshot(env, clientOpts(clientProject(capture), { updateBaselines: true }));
    await runSnapshot(env, clientOpts(clientProject(capture)));
    h.mismatchPercentage = 3.1;
    h.writeContextDiff = true;
    await runSnapshot(env, clientOpts(clientProject(Buffer.from("old pixels"))));
    await runSnapshot(env, clientOpts(clientProject(null)));

    // flowsDir holds os.tmpdir() too, so this also covers the scratch dirs.
    const entries = await fs.readdir(tmpDir, { recursive: true });
    expect(entries.filter((e) => e.split(path.sep).includes("__baselines__"))).toEqual([]);
  });

  it("names the client's baseline, not its server copy, when it does not decode", async () => {
    // The real differ: the decode error and its text are what is under test.
    const actual = await vi.importActual<
      typeof import("../../src/tools/screenshot-diff/screenshot-diff")
    >("../../src/tools/screenshot-diff/screenshot-diff");
    vi.mocked(diffPngFiles).mockImplementationOnce(actual.diffPngFiles);
    await writeRealPng(h.shotPath, 390, 844);
    // A Git LFS pointer checked out in place of the image.
    const project = clientProject(Buffer.from("version https://git-lfs.github.com/spec/v1\n"));

    const err = await runSnapshot(env, clientOpts(project)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FailureError);
    const prefix = `Could not read PNG at ${clientBaseline}: `;
    expect((err as Error).message.slice(0, prefix.length)).toBe(prefix);
    expect((err as Error).message).not.toContain("argent-flow-baseline-");
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.SCREENSHOT_DIFF_INPUT_INVALID,
      failure_stage: "screenshot_diff_decode_failed",
    });
    // The copy it no longer names is gone.
    await expect(baselineCopyDirs()).resolves.toEqual([]);
  });

  it("passes a client's read error through as it is", async () => {
    const project = clientProject(null);
    // The run's own abort must stay an AbortError, which the runner reports as
    // a skip; the client names every other failure itself.
    const abort = Object.assign(
      new Error("the client disconnected before answering the read-file request"),
      { name: "AbortError" }
    );
    project.readFile.mockRejectedValueOnce(abort);

    await expect(runSnapshot(env, clientOpts(project))).rejects.toBe(abort);
  });

  it("propagates a client read failure", async () => {
    const project = clientProject(null);
    const failure = new FailureError("the client did not answer the read-file request", {
      error_code: FAILURE_CODES.FLOW_CLIENT_NOT_ANSWERING,
      failure_stage: "client_request_timeout",
      failure_area: "tool_server",
      error_kind: "timeout",
    });
    project.readFile.mockRejectedValueOnce(failure);

    await expect(runSnapshot(env, clientOpts(project))).rejects.toBe(failure);
    expect(project.writeBaseline).not.toHaveBeenCalled();
    await expect(baselineCopyDirs()).resolves.toEqual([]);
  });

  it("propagates a client write failure instead of reporting the baseline written", async () => {
    const project = clientProject(null);
    const refusal = new Error("the client refused to write outside its roots");
    project.writeBaseline.mockRejectedValueOnce(refusal);

    await expect(runSnapshot(env, clientOpts(project, { updateBaselines: true }))).rejects.toBe(
      refusal
    );
    await expect(baselineCopyDirs()).resolves.toEqual([]);
  });
});
