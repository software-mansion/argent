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
  DEFAULT_ACTION_TIMEOUT_MS,
  settleTree,
  invokeOnDevice,
  waitForFrameResult,
  type ActionEnv,
  type SettleResult,
} from "../../src/tools/flows/flow-actions";
import { FlowTreeSourceUnavailableError } from "../../src/tools/flows/flow-errors";
import { settlePixels } from "../../src/tools/flows/flow-pixels";

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
  /** What the waitForFrameResult mock resolves a cropOn selector to. */
  cropFrame: undefined as
    | undefined
    | "aborted"
    | { x: number; y: number; width: number; height: number },
  cropSettle: {
    tree: {} as never,
    converged: true,
    treeFresh: true,
    visual: "settled",
  } as SettleResult,
  /** When set, the waitForFrameResult mock rejects with this (a tree-source outage). */
  cropFrameError: null as null | Error,
  dimensionMismatch: null as null | {
    expected: { width: number; height: number };
    actual: { width: number; height: number };
  },
}));

// Keep the real module (the snapshot settler shares its deadline constants,
// and cropOn failures must surface the directives' standard not-found reason
// from the real offscreenHint); stub only the settle and dispatch entry points.
vi.mock("../../src/tools/flows/flow-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-actions")>()),
  settleTree: vi.fn(async () => ({
    tree: {},
    converged: true,
    treeFresh: true,
    visual: "settled",
  })),
  invokeOnDevice: vi.fn(async () => ({ image: { hostPath: h.shotPath } })),
  waitForFrameResult: vi.fn(async () => {
    if (h.cropFrameError) throw h.cropFrameError;
    return h.cropFrame === "aborted"
      ? { frame: "aborted" as const }
      : { frame: h.cropFrame, settle: h.cropSettle };
  }),
}));

vi.mock("../../src/tools/flows/flow-pixels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-pixels")>()),
  settlePixels: vi.fn(async () => "settled"),
}));

vi.mock("../../src/tools/screenshot-diff/screenshot-diff", () => ({
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
    ...overrides,
  };
}

function treeOutage(message = "native devtools is unavailable"): FlowTreeSourceUnavailableError {
  return new FlowTreeSourceUnavailableError(new Error(message));
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
  h.cropSettle = {
    tree: {} as never,
    converged: true,
    treeFresh: true,
    visual: "settled",
  };
  h.cropFrameError = null;
  h.dimensionMismatch = null;
  vi.mocked(settleTree)
    .mockReset()
    .mockResolvedValue({
      tree: {} as never,
      converged: true,
      treeFresh: true,
      visual: "settled",
    });
  vi.mocked(settlePixels).mockReset().mockResolvedValue("settled");
  vi.mocked(invokeOnDevice)
    .mockReset()
    .mockImplementation(async () => ({ image: { hostPath: h.shotPath } }));
  await writeFakePng(h.shotPath);
});
afterEach(async () => {
  vi.useRealTimers();
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
  it("finishes the combined settle before capturing the snapshot", async () => {
    vi.mocked(settleTree).mockClear();
    vi.mocked(invokeOnDevice).mockClear();

    await runSnapshot(env, opts({ updateBaselines: true }));

    // The settle rides the shared action deadline so its retries stay bounded.
    expect(vi.mocked(settleTree)).toHaveBeenCalledWith(env, {
      absoluteDeadline: expect.any(Number),
    });
    expect(vi.mocked(settleTree).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invokeOnDevice).mock.invocationCallOrder[0]!
    );
    expect(vi.mocked(settlePixels)).not.toHaveBeenCalled();
  });

  it("falls back to pixel-only settling before capture when the tree source is down", async () => {
    // settleTree throws when every read in its window failed (native devtools
    // disconnected). The capture reads pixels, not the tree — the snapshot
    // must still capture and compare instead of reporting an error.
    vi.mocked(settleTree).mockRejectedValueOnce(treeOutage());
    vi.mocked(invokeOnDevice).mockClear();
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("pass");
    expect(r.reason).not.toContain("degraded");
    expect(vi.mocked(settlePixels)).toHaveBeenCalledWith(env, {
      absoluteDeadline: expect.any(Number),
    });
    expect(vi.mocked(settlePixels).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invokeOnDevice).mock.invocationCallOrder[0]!
    );
    expect(vi.mocked(invokeOnDevice)).toHaveBeenCalledWith(env, "screenshot", expect.anything());
  });

  it("degrades — not skips — when the outage fallback starts with the window already spent", async () => {
    // The first tree settle can consume the entire action window before it
    // proves the source down (a failing read completing at the very end), so
    // the pixels-only fallback enters with zero budget. Drive the REAL
    // settlePixels through that shape: its zero-budget outcome is
    // load-bearing — "timed-out" degrades the comparison honestly, while
    // "aborted" would turn this uncancelled run into a skip blaming a
    // cancellation that never happened.
    vi.useFakeTimers();
    const actual = await vi.importActual<typeof import("../../src/tools/flows/flow-pixels")>(
      "../../src/tools/flows/flow-pixels"
    );
    vi.mocked(settlePixels).mockImplementationOnce(actual.settlePixels);
    vi.mocked(settleTree).mockImplementationOnce(async () => {
      vi.advanceTimersByTime(DEFAULT_ACTION_TIMEOUT_MS + 1);
      throw treeOutage();
    });
    vi.mocked(invokeOnDevice).mockClear();
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("best-effort/degraded");
    // "timed out", not "unavailable": the settle launched nothing, so it may
    // not blame the capture backend (env has no registry — a capture attempt
    // would soft-fail into "unavailable" and trip this).
    expect(r.reason).toContain("timed out");
    // The snapshot still captured and compared — one screenshot dispatch, no
    // settle-side captures.
    expect(vi.mocked(invokeOnDevice)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokeOnDevice)).toHaveBeenCalledWith(env, "screenshot", expect.anything());
  });

  it.each(["timed-out", "unavailable"] as const)(
    "reports an ordinary comparison as degraded when pixel-only settling is %s",
    async (outcome) => {
      vi.mocked(settleTree).mockRejectedValueOnce(treeOutage());
      vi.mocked(settlePixels).mockResolvedValueOnce(outcome);
      await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
      await writeFakePng(baselinePath());

      const r = await runSnapshot(env, opts());

      expect(r.status).toBe("pass");
      expect(r.reason).toContain("best-effort/degraded");
      expect(r.reason).toContain(outcome === "timed-out" ? "timed out" : "unavailable");
    }
  );

  it("reports a missing-baseline capture as degraded when combined pixels are unavailable", async () => {
    vi.mocked(settleTree).mockResolvedValueOnce({
      tree: {} as never,
      converged: true,
      treeFresh: true,
      visual: "unavailable",
    });

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("no baseline");
    expect(r.reason).toContain("best-effort/degraded");
    expect(r.reason).toContain("unavailable");
  });

  it("compares undegraded when pixels settled but tree revalidation missed the deadline", async () => {
    vi.useFakeTimers();
    // A hung post-pixel read leaves `visual: "settled"` without freshness.
    // The settler prefers full convergence: it re-settles, the second settle
    // converges, and the comparison proceeds undegraded.
    vi.mocked(settleTree).mockResolvedValueOnce({
      tree: {} as never,
      converged: false,
      treeFresh: false,
      visual: "settled",
    });
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());

    const pending = runSnapshot(env, opts());
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await pending;

    expect(r.status).toBe("pass");
    expect(r.reason).not.toContain("degraded");
    expect(vi.mocked(settleTree)).toHaveBeenCalledTimes(2);
  });

  it("writes a baseline under updateBaselines when pixels settled without tree freshness", async () => {
    vi.useFakeTimers();
    vi.mocked(settleTree).mockResolvedValueOnce({
      tree: {} as never,
      converged: false,
      treeFresh: false,
      visual: "settled",
    });

    const pending = runSnapshot(env, opts({ updateBaselines: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await pending;

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("baseline written");
    expect(r.reason).not.toContain("degraded");
    await expect(fs.access(baselinePath())).resolves.toBeUndefined();
  });

  it("accepts the settled-but-stale screen only when the retry deadline exhausts", async () => {
    vi.useFakeTimers();
    // Every settle is visually settled but never tree-fresh (a persistently
    // slow source). The settler re-settles for freshness and accepts the
    // stale-but-settled screen only at deadline exhaustion.
    vi.mocked(settleTree).mockResolvedValue({
      tree: {} as never,
      converged: false,
      treeFresh: false,
      visual: "settled",
    });

    const pending = runSnapshot(env, opts({ updateBaselines: true }));
    await vi.advanceTimersByTimeAsync(8_000);
    const r = await pending;

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("baseline written");
    expect(r.reason).not.toContain("degraded");
    // The acceptance came from retry exhaustion, not from the first result.
    expect(vi.mocked(settleTree).mock.calls.length).toBeGreaterThan(2);
    await expect(fs.access(baselinePath())).resolves.toBeUndefined();
  });

  it("accepts an established stale settle when the tree source goes dark on the retry", async () => {
    vi.useFakeTimers();
    // The first settle proves the pixels stopped (visually settled, tree
    // stale); the freshness retry then finds the tree source dark. The outage
    // cannot un-prove that established stillness, so the snapshot proceeds on
    // it directly — no pixels-only fallback round re-deriving what the first
    // settle already proved, and no degradation note.
    vi.mocked(settleTree)
      .mockResolvedValueOnce({
        tree: {} as never,
        converged: false,
        treeFresh: false,
        visual: "settled",
      })
      .mockRejectedValueOnce(treeOutage());

    const pending = runSnapshot(env, opts({ updateBaselines: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await pending;

    expect(r.status).toBe("pass");
    expect(r.reason).toBe("baseline written (home__ios-390x844.png)");
    // The outage arrived on the freshness retry, not the first settle…
    expect(vi.mocked(settleTree)).toHaveBeenCalledTimes(2);
    // …and the stillness was accepted as-is, not re-proved from extra captures.
    expect(vi.mocked(settlePixels)).not.toHaveBeenCalled();
    await expect(fs.access(baselinePath())).resolves.toBeUndefined();
  });

  it("degrades a stale settle when a freshness retry observes the screen moving", async () => {
    vi.useFakeTimers();
    // The first settle proves stillness without the confirming tree read; the
    // freshness retry is a full settle whose pixel phase runs and never finds
    // a matching pair — the screen moved strictly AFTER the stale pair
    // matched, and the capture happens after the settle returns. The retry's
    // motion overrides the stale claim: the adopted baseline may show
    // mid-animation pixels, so the write must carry the timeout note instead
    // of reading like a clean one.
    vi.mocked(settleTree)
      .mockResolvedValueOnce({
        tree: {} as never,
        converged: false,
        treeFresh: false,
        visual: "settled",
      })
      .mockResolvedValue({
        tree: {} as never,
        converged: false,
        treeFresh: true,
        visual: "timed-out",
      });

    const pending = runSnapshot(env, opts({ updateBaselines: true }));
    await vi.advanceTimersByTimeAsync(8_000);
    const r = await pending;

    expect(r.status).toBe("pass");
    expect(r.reason).toBe(
      "baseline written (home__ios-390x844.png); " +
        "capture is best-effort/degraded because visual settling timed out"
    );
    // The motion round returned immediately — no retrying past observed
    // motion toward the deadline's undegraded stale-settled exit.
    expect(vi.mocked(settleTree)).toHaveBeenCalledTimes(2);
    await expect(fs.access(baselinePath())).resolves.toBeUndefined();
  });

  it("writes an undegraded baseline when a converged combined settle had no pixel phase", async () => {
    // A platform with no capture backend (Vega) converges with visual
    // "skipped": the absence is architectural, so the reason must read exactly
    // like any healthy write — no best-effort/degraded suffix.
    vi.mocked(settleTree).mockResolvedValue({
      tree: {} as never,
      converged: true,
      treeFresh: true,
      visual: "skipped",
    });
    const vegaEnv = { ...env, device: { platform: "vega", id: "vega-1" } } as unknown as ActionEnv;

    const r = await runSnapshot(vegaEnv, opts({ updateBaselines: true }));

    expect(r.status).toBe("pass");
    expect(r.reason).toBe("baseline written (home__vega-390x844.png)");
  });

  it("fails a missing baseline undegraded when the combined settle had no pixel phase", async () => {
    vi.mocked(settleTree).mockResolvedValue({
      tree: {} as never,
      converged: true,
      treeFresh: true,
      visual: "skipped",
    });
    const vegaEnv = { ...env, device: { platform: "vega", id: "vega-1" } } as unknown as ActionEnv;

    const r = await runSnapshot(vegaEnv, opts());

    expect(r.status).toBe("fail");
    expect(r.reason).toContain('no baseline for "home"');
    expect(r.reason).not.toContain("best-effort/degraded");
  });

  it("compares undegraded when the converged combined settle had no pixel phase", async () => {
    vi.mocked(settleTree).mockResolvedValue({
      tree: {} as never,
      converged: true,
      treeFresh: true,
      visual: "skipped",
    });
    const vegaEnv = { ...env, device: { platform: "vega", id: "vega-1" } } as unknown as ActionEnv;
    const vegaBaseline = path.join(tmpDir, "__baselines__", "checkout", "home__vega-390x844.png");
    await fs.mkdir(path.dirname(vegaBaseline), { recursive: true });
    await writeFakePng(vegaBaseline);

    const r = await runSnapshot(vegaEnv, opts());

    expect(r.status).toBe("pass");
    expect(r.reason).toBe("diff 0.00% ≤ 0.5% (home__vega-390x844.png)");
  });

  it("writes a degraded baseline when a restarted settle never re-observed pixels", async () => {
    // settleTree downgraded a pre-restart "settled" to "skipped" — the write
    // still proceeds best-effort, flagged as a settle timeout.
    vi.mocked(settleTree).mockResolvedValueOnce({
      tree: {} as never,
      converged: false,
      treeFresh: true,
      visual: "skipped",
    });

    const r = await runSnapshot(env, opts({ updateBaselines: true }));

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("baseline written");
    expect(r.reason).toContain("timed out");
    await expect(fs.access(baselinePath())).resolves.toBeUndefined();
  });

  it("degrades a non-converged unavailable settle as timed out, not merely unavailable", async () => {
    // converged: false alongside "unavailable" hides an earlier pixel
    // timeout — the note must name the timeout, not just unavailability.
    vi.mocked(settleTree).mockResolvedValueOnce({
      tree: {} as never,
      converged: false,
      treeFresh: true,
      visual: "unavailable",
    });

    const r = await runSnapshot(env, opts({ updateBaselines: true }));

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("baseline written");
    expect(r.reason).toContain("timed out");
    expect(r.reason).not.toContain("unavailable");
  });

  it("writes a missing baseline with a degradation note after settle timeout", async () => {
    vi.mocked(settleTree).mockResolvedValueOnce({
      tree: {} as never,
      converged: false,
      treeFresh: true,
      visual: "timed-out",
    });

    const r = await runSnapshot(env, opts({ updateBaselines: true }));

    // A timed-out settle degrades the write, never blocks it: the note warns
    // that the adopted baseline may show mid-animation pixels.
    expect(r.status).toBe("pass");
    expect(r.reason).toContain("baseline written");
    expect(r.reason).toContain("best-effort/degraded");
    expect(r.reason).toContain("timed out");
    expect(r.artifacts?.baseline).toMatchObject({
      __argentArtifact: true,
      hostPath: baselinePath(),
    });
    await expect(fs.access(baselinePath())).resolves.toBeUndefined();
  });

  it("updates an existing baseline with a degradation note after settle timeout", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath(), 390, 844);
    const before = await fs.readFile(baselinePath());
    await fs.appendFile(h.shotPath, Buffer.from("different-current"));
    vi.mocked(settleTree).mockResolvedValueOnce({
      tree: {} as never,
      converged: false,
      treeFresh: true,
      visual: "timed-out",
    });

    const r = await runSnapshot(env, opts({ updateBaselines: true }));

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("baseline updated");
    expect(r.reason).toContain("timed out");
    expect(await fs.readFile(baselinePath())).not.toEqual(before);
    expect(await fs.readFile(baselinePath())).toEqual(await fs.readFile(h.shotPath));
  });

  it("may write a baseline after a tree outage when pixel-only settling succeeds", async () => {
    vi.mocked(settleTree).mockRejectedValueOnce(treeOutage());

    const r = await runSnapshot(env, opts({ updateBaselines: true }));

    expect(r.status).toBe("pass");
    expect(r.reason).toContain("baseline written");
    await expect(fs.access(baselinePath())).resolves.toBeUndefined();
  });

  it("propagates an unrelated settle failure without capturing or seeding a baseline", async () => {
    const failure = new Error("tree fingerprint invariant failed");
    vi.mocked(settleTree).mockRejectedValueOnce(failure);
    vi.mocked(invokeOnDevice).mockClear();

    await expect(runSnapshot(env, opts({ updateBaselines: true }))).rejects.toBe(failure);

    expect(vi.mocked(settlePixels)).not.toHaveBeenCalled();
    expect(vi.mocked(invokeOnDevice)).not.toHaveBeenCalled();
    await expect(fs.access(baselinePath())).rejects.toThrow();
  });

  it("propagates an unrelated settle failure without capturing or overwriting a baseline", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());
    const before = await fs.readFile(baselinePath());
    const failure = new Error("unexpected settle implementation error");
    vi.mocked(settleTree).mockRejectedValueOnce(failure);
    vi.mocked(invokeOnDevice).mockClear();

    await expect(runSnapshot(env, opts({ updateBaselines: true }))).rejects.toBe(failure);

    expect(vi.mocked(settlePixels)).not.toHaveBeenCalled();
    expect(vi.mocked(invokeOnDevice)).not.toHaveBeenCalled();
    expect(await fs.readFile(baselinePath())).toEqual(before);
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

  it("preserves abort-as-skip when the pixel-only fallback is aborted", async () => {
    vi.mocked(settleTree).mockRejectedValueOnce(treeOutage());
    vi.mocked(settlePixels).mockResolvedValueOnce("aborted");
    vi.mocked(invokeOnDevice).mockClear();

    const r = await runSnapshot(env, opts());

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
    expect(vi.mocked(waitForFrameResult)).toHaveBeenCalledWith(env, cropOn);
    // waitForFrameResult settles internally — the plain settle must not run too.
    expect(vi.mocked(settleTree)).not.toHaveBeenCalled();
    // Key: the FULL capture's dimensions (device-class identity) plus the
    // selector hash (crop identity). Content: the crop.
    expect(r.snapshotKey).toBe(cropKey);
    await expect(pngSize(cropBaselinePath())).resolves.toEqual({ w: 50, h: 50 });
  });

  it("marks a cropOn baseline write degraded when its frame settle timed out", async () => {
    h.cropSettle = {
      tree: {} as never,
      converged: false,
      treeFresh: true,
      visual: "timed-out",
    };

    const r = await runSnapshot(env, opts({ updateBaselines: true, cropOn }));

    expect(r.status).toBe("pass");
    expect(r.reason).toBe(
      `baseline written (${cropKey}.png); ` +
        "capture is best-effort/degraded because visual settling timed out"
    );
    await expect(pngSize(cropBaselinePath())).resolves.toEqual({ w: 50, h: 50 });
  });

  it("writes an undegraded cropOn baseline when the frame settle had no pixel phase", async () => {
    // A platform with no capture backend (Vega, the Apple TV simulator)
    // converges with visual "skipped" — the pixel phase is architecturally
    // absent, not degraded, so the write must read like any healthy one.
    h.cropSettle = {
      tree: {} as never,
      converged: true,
      treeFresh: true,
      visual: "skipped",
    };

    const r = await runSnapshot(env, opts({ updateBaselines: true, cropOn }));

    expect(r.status).toBe("pass");
    expect(r.reason).toBe(`baseline written (${cropKey}.png)`);
    expect(r.artifacts?.baseline).toMatchObject({
      __argentArtifact: true,
      hostPath: cropBaselinePath(),
    });
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
    // Crops are never top-masked — the top of a crop is element content, not
    // the full screen's status bar.
    expect(h.diffTopMask).toBe("none");
    // Crop dims carry meaning — the differ must hard-fail any size drift.
    expect(h.diffNormalizeSizes).toBe(false);
    // …and the unregistered crop did not outlive the call.
    await expect(fs.access(path.dirname(h.diffCurrentPath))).rejects.toThrow();
  });

  it("marks a failing cropOn comparison degraded when visual settling was unavailable", async () => {
    await fs.mkdir(path.dirname(cropBaselinePath()), { recursive: true });
    await writeRealPng(cropBaselinePath(), 50, 50);
    h.mismatchPercentage = 3.1;
    h.cropSettle = {
      tree: {} as never,
      converged: true,
      treeFresh: true,
      visual: "unavailable",
    };

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("diff 3.10% > 0.5%");
    expect(r.reason).toContain(
      "capture is best-effort/degraded because visual settling was unavailable"
    );
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
    h.cropSettle = {
      tree: {} as never,
      converged: false,
      treeFresh: true,
      visual: "timed-out",
    };
    const preexistingCropDirs = new Set(
      (await fs.readdir(os.tmpdir())).filter((e) => e.startsWith("argent-flow-crop-"))
    );

    const r = await runSnapshot(env, opts({ cropOn }));

    expect(r.status).toBe("fail");
    expect(r.reason).toBe(
      `cropOn matched text="Header" but its on-screen region is ` +
        `empty at this resolution — nothing was compared; ` +
        `capture is best-effort/degraded because visual settling timed out`
    );
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
