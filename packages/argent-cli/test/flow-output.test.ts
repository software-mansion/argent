import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MaterializeContext } from "@argent/tools-client";
import { exportFailureArtifacts, type FlowReport, type StepReport } from "../src/flow.js";

let tmpDir: string;
let outDir: string;
/** The CLI-resolved YAML path the export derives its subdirectory from. */
let flowFile: string;

/** The deterministic disambiguation suffix for a flow path — mirrors the export's derivation. */
function pathHash(p: string): string {
  return createHash("sha256").update(p).digest("hex").slice(0, 8);
}

// Legacy string-path artifacts contain no handles, so materialization walks
// them without touching the network — the URL never resolves.
const ctx: MaterializeContext = { toolsUrl: "http://tools.invalid" };

async function writeFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content);
  return p;
}

/**
 * A wire artifact handle whose hostPath is a real local file, sized/stamped so
 * the materializer's co-location gate resolves it in place (no download).
 */
async function writeHandle(name: string, content: string): Promise<Record<string, unknown>> {
  const p = await writeFile(name, content);
  const st = await fs.stat(p);
  return {
    __argentArtifact: true,
    id: `id-${name}`,
    filename: name,
    mimeType: "image/png",
    size: st.size,
    mtimeMs: st.mtimeMs,
    hostPath: p,
  };
}

function mkReport(steps: StepReport[]): FlowReport {
  return {
    flow: "checkout",
    device: "UDID-1",
    ok: false,
    passed: 0,
    failed: 1,
    skipped: 0,
    errored: 0,
    steps,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-output-"));
  outDir = path.join(tmpDir, "out");
  // Only the path string matters to the export — the YAML is never read here.
  flowFile = path.join(tmpDir, "checkout.yaml");
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("exportFailureArtifacts", () => {
  it("copies every role of a failed snapshot to <output>/<flow>/<key>-<role>.png and rewrites the report", async () => {
    const baseline = await writeFile("b.png", "baseline-bytes");
    const current = await writeFile("c.png", "current-bytes");
    const diff = await writeFile("d.png", "diff-bytes");
    const step: StepReport = {
      index: 0,
      kind: "snapshot",
      status: "fail",
      snapshotKey: "home__ios-390x844",
      artifacts: { baseline, current, diff },
    };

    await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

    const dir = path.join(outDir, "checkout");
    for (const [role, content] of [
      ["baseline", "baseline-bytes"],
      ["current", "current-bytes"],
      ["diff", "diff-bytes"],
    ] as const) {
      const dest = path.join(dir, `home__ios-390x844-${role}.png`);
      expect(step.artifacts?.[role]).toBe(dest);
      expect(await fs.readFile(dest, "utf8")).toBe(content);
    }
  });

  it("leaves passed and baseline-seeded snapshots alone (failure-only)", async () => {
    const baseline = await writeFile("b.png", "baseline-bytes");
    const seeded: StepReport = {
      index: 0,
      kind: "snapshot",
      status: "pass",
      warning: "baseline created",
      snapshotKey: "home__ios-390x844",
      artifacts: { baseline },
    };

    await exportFailureArtifacts(mkReport([seeded]), outDir, flowFile, ctx);

    expect(seeded.artifacts?.baseline).toBe(baseline);
    await expect(fs.access(outDir)).rejects.toThrow();
  });

  it("derives the key from the baseline path when the server sent no snapshotKey", async () => {
    const baseline = await writeFile("home__android-1080x2400.png", "baseline-bytes");
    const step: StepReport = {
      index: 0,
      kind: "snapshot",
      status: "fail",
      artifacts: { baseline },
    };

    await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

    expect(step.artifacts?.baseline).toBe(
      path.join(outDir, "checkout", "home__android-1080x2400-baseline.png")
    );
  });

  it("skips unmaterialized (null) roles and steps with no usable key", async () => {
    const current = await writeFile("c.png", "current-bytes");
    const withNull: StepReport = {
      index: 0,
      kind: "snapshot",
      status: "fail",
      snapshotKey: "home__ios-390x844",
      artifacts: { baseline: null, current },
    };
    const keyless: StepReport = {
      index: 1,
      kind: "snapshot",
      status: "fail",
      artifacts: { current },
    };

    await exportFailureArtifacts(mkReport([withNull, keyless]), outDir, flowFile, ctx);

    expect(withNull.artifacts?.baseline).toBeNull();
    expect(withNull.artifacts?.current).toBe(
      path.join(outDir, "checkout", "home__ios-390x844-current.png")
    );
    // No snapshotKey and no baseline to derive one from — nothing written.
    expect(keyless.artifacts?.current).toBe(current);
  });

  it("materializes a co-located snapshot's handles in place and copies them without fetching", async () => {
    const step: StepReport = {
      index: 0,
      kind: "snapshot",
      status: "fail",
      snapshotKey: "home__ios-390x844",
      artifacts: {
        baseline: await writeHandle("b.png", "baseline-bytes"),
        current: await writeHandle("c.png", "current-bytes"),
        diff: await writeHandle("d.png", "diff-bytes"),
      },
    };
    const fetchSpy = vi.fn(async () => {
      throw new Error("unexpected network fetch");
    });

    await exportFailureArtifacts(mkReport([step]), outDir, flowFile, {
      toolsUrl: "http://tools.invalid",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    // The handles' hostPaths are on this machine — resolved in place, no wire.
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const [role, content] of [
      ["baseline", "baseline-bytes"],
      ["current", "current-bytes"],
      ["diff", "diff-bytes"],
    ] as const) {
      const dest = path.join(outDir, "checkout", `home__ios-390x844-${role}.png`);
      expect(step.artifacts?.[role]).toBe(dest);
      expect(await fs.readFile(dest, "utf8")).toBe(content);
    }
  });

  it("downloads a remote handle (no hostPath) and copies it under --output", async () => {
    const prevCache = process.env.ARGENT_ARTIFACTS_DIR;
    process.env.ARGENT_ARTIFACTS_DIR = path.join(tmpDir, "cache");
    try {
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: {
          diff: {
            __argentArtifact: true,
            id: "diff-1",
            filename: "remote-diff.png",
            mimeType: "image/png",
            size: 10,
          },
        },
      };
      const fetchSpy = vi.fn(async () => new Response("diff-bytes"));

      await exportFailureArtifacts(mkReport([step]), outDir, flowFile, {
        toolsUrl: "http://tools.invalid",
        authToken: "tok",
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith("http://tools.invalid/artifacts/diff-1", {
        headers: { Authorization: "Bearer tok" },
      });
      const dest = path.join(outDir, "checkout", "home__ios-390x844-diff.png");
      expect(step.artifacts?.diff).toBe(dest);
      expect(await fs.readFile(dest, "utf8")).toBe("diff-bytes");
    } finally {
      if (prevCache === undefined) delete process.env.ARGENT_ARTIFACTS_DIR;
      else process.env.ARGENT_ARTIFACTS_DIR = prevCache;
    }
  });

  it("refuses a flow path whose stem is traversal: warns, writes nothing, downloads nothing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A remote handle (no hostPath) would force a download — proving the
      // guard fires before materialization, not just before the copy.
      const handle = {
        __argentArtifact: true,
        id: "diff-1",
        filename: "remote-diff.png",
        mimeType: "image/png",
        size: 10,
      };
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { diff: handle },
      };
      const fetchSpy = vi.fn(async () => new Response("diff-bytes"));

      // The CLI validates the stem before ever calling the export, but the
      // function must stay safe in isolation: a path ending in "/.." has the
      // basename "..", which would resolve the subdirectory to outDir's parent.
      await exportFailureArtifacts(mkReport([step]), outDir, `${tmpDir}${path.sep}..`, {
        toolsUrl: "http://tools.invalid",
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(step.artifacts?.diff).toBe(handle);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unsafe flow filename"));
      await expect(fs.access(outDir)).rejects.toThrow();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("ignores the wire report's flow field when picking the destination", async () => {
    // The export dir comes from the CLI-resolved path only — a server-sent
    // report.flow (even a hostile one) must not steer the copy anywhere else.
    const current = await writeFile("c.png", "current-bytes");
    const step: StepReport = {
      index: 0,
      kind: "snapshot",
      status: "fail",
      snapshotKey: "home__ios-390x844",
      artifacts: { current },
    };

    await exportFailureArtifacts({ ...mkReport([step]), flow: "../escape" }, outDir, flowFile, ctx);

    expect(step.artifacts?.current).toBe(
      path.join(outDir, "checkout", "home__ios-390x844-current.png")
    );
    await expect(fs.access(path.join(tmpDir, "escape"))).rejects.toThrow();
  });

  it("skips a step whose snapshotKey contains path traversal, still exporting safe steps", async () => {
    const evil = await writeFile("evil.png", "evil-bytes");
    const good = await writeFile("good.png", "good-bytes");
    const badStep: StepReport = {
      index: 0,
      kind: "snapshot",
      status: "fail",
      snapshotKey: "../../pwned",
      artifacts: { current: evil },
    };
    const goodStep: StepReport = {
      index: 1,
      kind: "snapshot",
      status: "fail",
      snapshotKey: "home__ios-390x844",
      artifacts: { current: good },
    };

    await exportFailureArtifacts(mkReport([badStep, goodStep]), outDir, flowFile, ctx);

    // Untouched — the join would have resolved to <tmpDir>/pwned-current.png.
    expect(badStep.artifacts?.current).toBe(evil);
    await expect(fs.access(path.join(tmpDir, "pwned-current.png"))).rejects.toThrow();
    expect(goodStep.artifacts?.current).toBe(
      path.join(outDir, "checkout", "home__ios-390x844-current.png")
    );
  });

  it("skips a step whose baseline-derived key reduces to '..'", async () => {
    // path.basename("<dir>/..") is ".." — the fallback alone can't contain it.
    const step: StepReport = {
      index: 0,
      kind: "snapshot",
      status: "fail",
      artifacts: { baseline: `${tmpDir}${path.sep}..` },
    };

    await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

    expect(step.artifacts?.baseline).toBe(`${tmpDir}${path.sep}..`);
    await expect(fs.access(outDir)).rejects.toThrow();
  });

  it("warns and keeps the temp path when a source file is unreadable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const gone = path.join(tmpDir, "vanished.png");
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { diff: gone },
      };

      await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

      expect(step.artifacts?.diff).toBe(gone);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("warning: could not write"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("keeps both flows' evidence when two different files share a filename stem", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // "Paths anywhere" makes suiteA/checks.yaml + suiteB/checks.yaml the
      // natural CI layout, both exporting into one --output dir.
      const flowA = path.join(tmpDir, "suiteA", "checks.yaml");
      const flowB = path.join(tmpDir, "suiteB", "checks.yaml");
      const stepA: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "shot__ios-390x844",
        artifacts: { current: await writeFile("a.png", "suiteA-bytes") },
      };
      const stepB: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "shot__ios-390x844",
        artifacts: { current: await writeFile("b.png", "suiteB-bytes") },
      };

      await exportFailureArtifacts(mkReport([stepA]), outDir, flowA, ctx);
      await exportFailureArtifacts(mkReport([stepB]), outDir, flowB, ctx);

      // The first file keeps the documented <output>/<stem>/ path…
      const aDest = path.join(outDir, "checks", "shot__ios-390x844-current.png");
      expect(stepA.artifacts?.current).toBe(aDest);
      expect(await fs.readFile(aDest, "utf8")).toBe("suiteA-bytes");
      // …and the second lands in the deterministic hash-suffixed sibling, so
      // neither run's evidence replaced the other's — with a warning saying so.
      const bDest = path.join(outDir, `checks-${pathHash(flowB)}`, "shot__ios-390x844-current.png");
      expect(stepB.artifacts?.current).toBe(bDest);
      expect(await fs.readFile(bDest, "utf8")).toBe("suiteB-bytes");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(`checks-${pathHash(flowB)}`));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(flowA));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("re-exports the same flow file in place: same paths, fresh bytes, no extra directories", async () => {
    const mkStep = async (content: string): Promise<StepReport> => ({
      index: 0,
      kind: "snapshot",
      status: "fail",
      snapshotKey: "home__ios-390x844",
      artifacts: { current: await writeFile("c.png", content) },
    });
    const dest = path.join(outDir, "checkout", "home__ios-390x844-current.png");

    // A CI re-run of one flow into a reused --output dir must keep the stable
    // documented path and overwrite, never accumulate hash-suffixed siblings.
    const first = await mkStep("run1-bytes");
    await exportFailureArtifacts(mkReport([first]), outDir, flowFile, ctx);
    expect(first.artifacts?.current).toBe(dest);

    const second = await mkStep("run2-bytes");
    await exportFailureArtifacts(mkReport([second]), outDir, flowFile, ctx);

    expect(second.artifacts?.current).toBe(dest);
    expect(await fs.readFile(dest, "utf8")).toBe("run2-bytes");
    expect(await fs.readdir(outDir)).toEqual(["checkout"]);
    // The claim marker names the producing YAML so uploaded artifacts stay
    // auditable and the next run can recognize its own directory.
    expect(await fs.readFile(path.join(outDir, "checkout", ".argent-flow-source"), "utf8")).toBe(
      `${flowFile}\n`
    );
  });

  it("redirects away from a same-named directory it cannot prove it owns", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // No marker → operator files or a pre-marker export; either way the
      // export cannot tell it is its own, so it must not overwrite into it.
      await fs.mkdir(path.join(outDir, "checkout"), { recursive: true });
      await fs.writeFile(path.join(outDir, "checkout", "keep.txt"), "operator data");
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: await writeFile("c.png", "current-bytes") },
      };

      await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

      expect(await fs.readFile(path.join(outDir, "checkout", "keep.txt"), "utf8")).toBe(
        "operator data"
      );
      expect(step.artifacts?.current).toBe(
        path.join(outDir, `checkout-${pathHash(flowFile)}`, "home__ios-390x844-current.png")
      );
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("an unknown source"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("leaves --output untouched when a colliding flow has nothing to export", async () => {
    // A clean pass must neither warn about a collision nor create directories
    // or markers — the no-write invariant holds even when the stem is taken.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const owned: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: await writeFile("c.png", "current-bytes") },
      };
      await exportFailureArtifacts(mkReport([owned]), outDir, flowFile, ctx);
      errSpy.mockClear();

      const passing: StepReport = { index: 0, kind: "snapshot", status: "pass" };
      await exportFailureArtifacts(
        mkReport([passing]),
        outDir,
        path.join(tmpDir, "other", "checkout.yaml"),
        ctx
      );

      expect(errSpy).not.toHaveBeenCalled();
      expect(await fs.readdir(outDir)).toEqual(["checkout"]);
    } finally {
      errSpy.mockRestore();
    }
  });
});
