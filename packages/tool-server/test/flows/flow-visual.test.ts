import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSnapshot } from "../../src/tools/flows/flow-visual";
import { ArtifactStore } from "../../src/artifacts";
import type { ActionEnv } from "../../src/tools/flows/flow-actions";

// Stub settle + capture so the tests exercise only the baseline write/diff decision.
const h = vi.hoisted(() => ({
  shotPath: "",
  mismatchPercentage: 0,
  contextDiffPath: "",
  dimensionMismatch: null as null | {
    expected: { width: number; height: number };
    actual: { width: number; height: number };
  },
}));

vi.mock("../../src/tools/flows/flow-actions", () => ({
  settleTree: vi.fn(async () => ({})),
  invokeOnDevice: vi.fn(async () => ({ image: { hostPath: h.shotPath } })),
}));

vi.mock("../../src/tools/screenshot-diff/screenshot-diff", () => ({
  diffPngFiles: vi.fn(async () => ({
    mismatchPercentage: h.mismatchPercentage,
    contextDiffPath: h.contextDiffPath || undefined,
    dimensionMismatch: h.dimensionMismatch ?? undefined,
  })),
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

const baselinePath = () => path.join(tmpDir, "__baselines__", "checkout", "home__ios-390x844.png");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-visual-"));
  h.shotPath = path.join(tmpDir, "shot.png");
  h.mismatchPercentage = 0;
  h.contextDiffPath = "";
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
    h.contextDiffPath = path.join(tmpDir, "context-diff.png");
    await writeFakePng(h.contextDiffPath);

    const r = await runSnapshot(env, opts());

    expect(r.status).toBe("fail");
    expect(r.reason).toContain("diff 3.10% > 0.5%");
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
