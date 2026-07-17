import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSnapshot } from "../../src/tools/flows/flow-visual";
import { ArtifactStore } from "../../src/artifacts";
import { settleTree, invokeOnDevice, type ActionEnv } from "../../src/tools/flows/flow-actions";
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
  dimensionMismatch: null as null | {
    expected: { width: number; height: number };
    actual: { width: number; height: number };
  },
}));

vi.mock("../../src/tools/flows/flow-actions", () => ({
  settleTree: vi.fn(async () => ({
    tree: {},
    converged: true,
    treeFresh: true,
    visual: "settled",
  })),
  invokeOnDevice: vi.fn(async () => ({ image: { hostPath: h.shotPath } })),
}));

vi.mock("../../src/tools/flows/flow-pixels", () => ({
  settlePixels: vi.fn(async () => "settled"),
}));

vi.mock("../../src/tools/screenshot-diff/screenshot-diff", () => ({
  diffPngFiles: vi.fn(async (options: { outputDir: string }) => {
    h.outputDir = options.outputDir;
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
    expect(r.snapshotKey).toBe("home__ios-390x844");
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
    // A clean pass carries no artifacts — there is nothing to look at, and
    // handles would make renderers fetch two full-res PNGs just to print paths.
    expect(r.artifacts).toBeUndefined();
    expect(r.snapshotKey).toBeUndefined();
  });

  it("fails a dimension-mismatch bail instead of passing its 0% mismatch", async () => {
    await fs.mkdir(path.dirname(baselinePath()), { recursive: true });
    await writeFakePng(baselinePath());
    h.dimensionMismatch = {
      expected: { width: 390, height: 844 },
      actual: { width: 393, height: 852 },
    };

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("390x844");
    expect(r.reason).toContain("393x852");
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

    expect(vi.mocked(settleTree)).toHaveBeenCalledWith(env);
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
    expect(vi.mocked(settlePixels)).toHaveBeenCalledWith(env);
    expect(vi.mocked(settlePixels).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invokeOnDevice).mock.invocationCallOrder[0]!
    );
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

  it("refuses to write a missing baseline after settle timeout and attaches the capture", async () => {
    vi.mocked(settleTree).mockResolvedValueOnce({
      tree: {} as never,
      converged: false,
      treeFresh: true,
      visual: "timed-out",
    });

    const r = await runSnapshot(env, opts({ updateBaselines: true }));

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("baseline not written");
    expect(r.reason).toContain("timed out");
    expect(r.artifacts?.current).toMatchObject({ hostPath: h.shotPath });
    expect(r.artifacts?.baseline).toBeUndefined();
    await expect(fs.access(baselinePath())).rejects.toThrow();
  });

  it("leaves an existing baseline untouched after settle timeout", async () => {
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

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("baseline not updated");
    expect(await fs.readFile(baselinePath())).toEqual(before);
    expect(r.artifacts?.current).toMatchObject({ hostPath: h.shotPath });
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
    h.dimensionMismatch = {
      expected: { width: 390, height: 844 },
      actual: { width: 393, height: 852 },
    };

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    await expect(fs.access(h.outputDir)).rejects.toThrow();
  });
});
