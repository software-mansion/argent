import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MaterializeContext } from "@argent/tools-client";
import { exportFailureArtifacts, type FlowReport, type StepReport } from "../src/flow.js";

// Spies over the real implementations, not stubs: every test here runs against
// a real temp filesystem. Only the three marker-window tests override anything,
// and only the marker's own read or exclusive create — reproducing the
// one-syscall windows around it: an O_EXCL create publishing the marker's path
// before its bytes land, and that same create losing to a marker that is gone
// again by the time the loser reads it. Racing real calls cannot schedule
// either deterministically. Node builtins can't be spied on in place (their
// ESM namespace is frozen), so the module is mocked.
vi.mock("node:fs/promises", { spy: true });

/**
 * Whether mode bits actually deny this process a write. `chmod 0555` means
 * nothing to root (some CI containers run as root) and nothing on Windows, and
 * there the refused-claim fixtures would be writable — the assertions would
 * pass for the wrong reason, so skip them instead.
 */
const canDenyWrite = process.platform !== "win32" && process.getuid?.() !== 0;

let tmpDir: string;
let outDir: string;
/** The CLI-resolved YAML path the export derives its subdirectory from. */
let flowFile: string;

/** The deterministic disambiguation suffix for a flow path — mirrors the export's derivation. */
function pathHash(p: string, len = 8): string {
  return createHash("sha256").update(p).digest("hex").slice(0, len);
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
      // "files", not "artifacts" — the export can't know what a markerless
      // directory's contents are, only that they exist.
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("already holds files from an unknown source")
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("escalates past an occupied redirect target instead of overwriting its evidence", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The reviewer's collision: <stem>/ is taken by suiteA, and the hash8
      // redirect target is ALREADY claimed by another flow (in the wild, one
      // whose stem is literally "checks-<hash8>"). Reproduced deterministically
      // by pre-creating <stem>-<hash8> — computed from the real flow path the
      // same way the source does — with a marker naming that other owner.
      const flowA = path.join(tmpDir, "suiteA", "checks.yaml");
      const flowB = path.join(tmpDir, "suiteB", "checks.yaml");
      const h8 = pathHash(flowB);
      const suiteD = path.join(tmpDir, "suiteD", `checks-${h8}.yaml`);
      await fs.mkdir(path.join(outDir, "checks"), { recursive: true });
      await fs.writeFile(path.join(outDir, "checks", ".argent-flow-source"), `${flowA}\n`);
      const occupied = path.join(outDir, `checks-${h8}`);
      await fs.mkdir(occupied, { recursive: true });
      await fs.writeFile(path.join(occupied, ".argent-flow-source"), `${suiteD}\n`);
      await fs.writeFile(path.join(occupied, "shot__ios-390x844-current.png"), "suiteD-bytes");
      const stepB: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "shot__ios-390x844",
        artifacts: { current: await writeFile("b.png", "suiteB-bytes") },
      };

      await exportFailureArtifacts(mkReport([stepB]), outDir, flowB, ctx);

      // suiteD's evidence survives byte-for-byte, marker included.
      expect(await fs.readFile(path.join(occupied, ".argent-flow-source"), "utf8")).toBe(
        `${suiteD}\n`
      );
      expect(await fs.readFile(path.join(occupied, "shot__ios-390x844-current.png"), "utf8")).toBe(
        "suiteD-bytes"
      );
      // suiteB lands one rung up the deterministic ladder: the 16-char prefix.
      const dest = path.join(outDir, `checks-${pathHash(flowB, 16)}`);
      expect(stepB.artifacts?.current).toBe(path.join(dest, "shot__ios-390x844-current.png"));
      expect(await fs.readFile(stepB.artifacts?.current as string, "utf8")).toBe("suiteB-bytes");
      // One warning per avoided directory, each naming its owner — and every
      // warning names the directory the artifacts actually land in.
      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `${path.join(outDir, "checks")} already holds artifacts from ${flowA}`
        )
      );
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${occupied} already holds artifacts from ${suiteD}`)
      );
      for (const call of errSpy.mock.calls) {
        expect(call[0]).toContain(`writing this flow's artifacts to ${dest}`);
      }
    } finally {
      errSpy.mockRestore();
    }
  });

  it("escalates past a markerless non-empty redirect target the same as a markerless stem", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Both the stem and the hash8 fallback hold unowned files — the export
      // can prove neither is its own, so it must step past both.
      await fs.mkdir(path.join(outDir, "checkout"), { recursive: true });
      await fs.writeFile(path.join(outDir, "checkout", "keep.txt"), "operator data");
      const occupied = path.join(outDir, `checkout-${pathHash(flowFile)}`);
      await fs.mkdir(occupied, { recursive: true });
      await fs.writeFile(path.join(occupied, "keep.txt"), "more operator data");
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: await writeFile("c.png", "current-bytes") },
      };

      await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

      expect(await fs.readFile(path.join(occupied, "keep.txt"), "utf8")).toBe("more operator data");
      expect(step.artifacts?.current).toBe(
        path.join(outDir, `checkout-${pathHash(flowFile, 16)}`, "home__ios-390x844-current.png")
      );
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(`${occupied} already holds files from an unknown source`)
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("claims a pre-created empty redirect target, consistent with the stem-dir rule", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await fs.mkdir(path.join(outDir, "checkout"), { recursive: true });
      await fs.writeFile(path.join(outDir, "checkout", "keep.txt"), "operator data");
      const target = path.join(outDir, `checkout-${pathHash(flowFile)}`);
      await fs.mkdir(target, { recursive: true }); // empty — nothing to protect
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: await writeFile("c.png", "current-bytes") },
      };

      await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

      const dest = path.join(target, "home__ios-390x844-current.png");
      expect(step.artifacts?.current).toBe(dest);
      expect(await fs.readFile(dest, "utf8")).toBe("current-bytes");
      // Claimed with the usual marker — no escalation to a longer prefix.
      expect(await fs.readFile(path.join(target, ".argent-flow-source"), "utf8")).toBe(
        `${flowFile}\n`
      );
      expect((await fs.readdir(outDir)).sort()).toEqual([
        "checkout",
        `checkout-${pathHash(flowFile)}`,
      ]);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(target));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("re-runs a redirected flow into its established hash directory, overwriting in place", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The stem stays foreign across runs; the flow's own marker in the
      // hash8 directory is what lets a later invocation overwrite in place —
      // the stable redirect name CI references depend on.
      await fs.mkdir(path.join(outDir, "checkout"), { recursive: true });
      await fs.writeFile(path.join(outDir, "checkout", "keep.txt"), "operator data");
      const mkStep = async (content: string): Promise<StepReport> => ({
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: await writeFile("c.png", content) },
      });
      const dest = path.join(
        outDir,
        `checkout-${pathHash(flowFile)}`,
        "home__ios-390x844-current.png"
      );

      const first = await mkStep("run1-bytes");
      await exportFailureArtifacts(mkReport([first]), outDir, flowFile, ctx);
      expect(first.artifacts?.current).toBe(dest);

      const second = await mkStep("run2-bytes");
      await exportFailureArtifacts(mkReport([second]), outDir, flowFile, ctx);

      expect(second.artifacts?.current).toBe(dest);
      expect(await fs.readFile(dest, "utf8")).toBe("run2-bytes");
      // No longer-prefix siblings accumulate across re-runs.
      expect((await fs.readdir(outDir)).sort()).toEqual([
        "checkout",
        `checkout-${pathHash(flowFile)}`,
      ]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("skips the export entirely when every candidate directory is foreign", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Squat on the stem and the whole prefix ladder, full hash included —
      // only then may the export give up, and it must warn instead of write.
      const fullHash = pathHash(flowFile, 64);
      const names = ["checkout"];
      for (let len = 8; len <= 64; len += 8) names.push(`checkout-${fullHash.slice(0, len)}`);
      for (const name of names) {
        await fs.mkdir(path.join(outDir, name), { recursive: true });
        await fs.writeFile(path.join(outDir, name, "keep.txt"), `squatting ${name}`);
      }
      const source = await writeFile("c.png", "current-bytes");
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: source },
      };

      await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

      // Source path left in place, nothing created, every squatter untouched.
      expect(step.artifacts?.current).toBe(source);
      expect((await fs.readdir(outDir)).sort()).toEqual([...names].sort());
      for (const name of names) {
        expect(await fs.readFile(path.join(outDir, name, "keep.txt"), "utf8")).toBe(
          `squatting ${name}`
        );
      }
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(`not exporting artifacts for ${flowFile}`)
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("claims a pre-created empty directory: documented path, marker written, no warning", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // `mkdir -p out/checkout` before the run is an ordinary CI step — an
      // empty directory holds nothing to protect, so the export must keep the
      // stable <output>/<flow>/ path instead of redirecting forever.
      await fs.mkdir(path.join(outDir, "checkout"), { recursive: true });
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: await writeFile("c.png", "current-bytes") },
      };

      await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

      const dest = path.join(outDir, "checkout", "home__ios-390x844-current.png");
      expect(step.artifacts?.current).toBe(dest);
      expect(await fs.readFile(dest, "utf8")).toBe("current-bytes");
      expect(await fs.readdir(outDir)).toEqual(["checkout"]); // no hash-suffixed sibling
      // The claim is completed with the usual marker, so the next run of this
      // same file recognizes the directory and overwrites in place.
      expect(await fs.readFile(path.join(outDir, "checkout", ".argent-flow-source"), "utf8")).toBe(
        `${flowFile}\n`
      );
      expect(errSpy).not.toHaveBeenCalled();
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

  it("gives two concurrent runs of different files sharing a stem their own directories", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The CI shape the marker exists for: two suites' checks.yaml exporting
      // into one --output at the same time. Both classify <output>/checks
      // before either has written anything into it, so nothing but the marker's
      // exclusive create can separate them — a classify-then-claim protocol
      // lets both write there, leaving a directory whose marker names one flow
      // while holding the other's bytes.
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

      await Promise.all([
        exportFailureArtifacts(mkReport([stepA]), outDir, flowA, ctx),
        exportFailureArtifacts(mkReport([stepB]), outDir, flowB, ctx),
      ]);

      // Two directories, never one — whichever run won <output>/checks, the
      // other took its own deterministic hash rung.
      expect(await fs.readdir(outDir)).toHaveLength(2);
      for (const [flow, step, bytes] of [
        [flowA, stepA, "suiteA-bytes"],
        [flowB, stepB, "suiteB-bytes"],
      ] as const) {
        const dest = step.artifacts?.current as string;
        const dir = path.dirname(dest);
        expect([
          path.join(outDir, "checks"),
          path.join(outDir, `checks-${pathHash(flow)}`),
        ]).toContain(dir);
        // The marker names the flow whose bytes are actually in the directory:
        // the property a lost race silently breaks, and the one a later run of
        // the named flow then relies on to overwrite in place.
        expect(await fs.readFile(path.join(dir, ".argent-flow-source"), "utf8")).toBe(`${flow}\n`);
        expect(await fs.readFile(dest, "utf8")).toBe(bytes);
        // Marker + this run's one PNG, so nothing of the other run leaked in.
        expect((await fs.readdir(dir)).sort()).toEqual([
          ".argent-flow-source",
          "shot__ios-390x844-current.png",
        ]);
      }
      expect(path.dirname(stepA.artifacts?.current as string)).not.toBe(
        path.dirname(stepB.artifacts?.current as string)
      );
      // Exactly one redirect warning: the run that lost the stem directory,
      // whether it lost by classification or by the claim.
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("escalates to its hash directory when the marker's exclusive create loses the race", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Pre-created and empty, so both runs classify <output>/checks as free
      // ("nothing to protect") and neither can be redirected by the read alone.
      // Exactly one wins the create; the loser must read the winner's marker
      // and treat it like any other foreign owner — same escalation, same
      // warning as a classify-time verdict.
      await fs.mkdir(path.join(outDir, "checks"), { recursive: true });
      const flowA = path.join(tmpDir, "suiteA", "checks.yaml");
      const flowB = path.join(tmpDir, "suiteB", "checks.yaml");
      const mkStep = async (name: string, content: string): Promise<StepReport> => ({
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "shot__ios-390x844",
        artifacts: { current: await writeFile(name, content) },
      });
      const stepA = await mkStep("a.png", "suiteA-bytes");
      const stepB = await mkStep("b.png", "suiteB-bytes");

      await Promise.all([
        exportFailureArtifacts(mkReport([stepA]), outDir, flowA, ctx),
        exportFailureArtifacts(mkReport([stepB]), outDir, flowB, ctx),
      ]);

      // Winner-agnostic: whoever holds the pre-created stem directory won.
      const stemDir = path.join(outDir, "checks");
      const a = { flow: flowA, dir: path.dirname(stepA.artifacts?.current as string) };
      const b = { flow: flowB, dir: path.dirname(stepB.artifacts?.current as string) };
      const [winner, loser] = a.dir === stemDir ? [a, b] : [b, a];
      expect(winner.dir).toBe(stemDir);
      expect(loser.dir).toBe(path.join(outDir, `checks-${pathHash(loser.flow)}`));
      expect(await fs.readFile(path.join(stemDir, ".argent-flow-source"), "utf8")).toBe(
        `${winner.flow}\n`
      );
      expect(errSpy).toHaveBeenCalledWith(
        `warning: ${stemDir} already holds artifacts from ${winner.flow}; ` +
          `writing this flow's artifacts to ${loser.dir} so neither set is overwritten`
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("keeps two concurrent runs of the same flow file in one directory", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Two runs of one file are indistinguishable to a separate process, so
      // the loser of the claim must recognize its own path in the winner's
      // marker and share the directory. Redirecting here would scatter one
      // flow's evidence across hash siblings on every parallel CI shard.
      const mkStep = async (name: string, content: string): Promise<StepReport> => ({
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: await writeFile(name, content) },
      });
      const first = await mkStep("c1.png", "run1-bytes");
      const second = await mkStep("c2.png", "run2-bytes");

      await Promise.all([
        exportFailureArtifacts(mkReport([first]), outDir, flowFile, ctx),
        exportFailureArtifacts(mkReport([second]), outDir, flowFile, ctx),
      ]);

      const dest = path.join(outDir, "checkout", "home__ios-390x844-current.png");
      expect(first.artifacts?.current).toBe(dest);
      expect(second.artifacts?.current).toBe(dest);
      expect(await fs.readdir(outDir)).toEqual(["checkout"]); // no spurious redirect
      expect(await fs.readFile(path.join(outDir, "checkout", ".argent-flow-source"), "utf8")).toBe(
        `${flowFile}\n`
      );
      expect(errSpy).not.toHaveBeenCalled();
      // Deliberately NOT fixed: both runs write the same key, so one set of
      // bytes wins — exactly as before any ownership machinery existed. The
      // marker is truthful either way, which is what makes it survivable.
      expect(["run1-bytes", "run2-bytes"]).toContain(await fs.readFile(dest, "utf8"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("escalates when the marker that beat its exclusive create is gone by the time it reads it", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stemDir = path.join(outDir, "checkout");
    const marker = path.join(stemDir, ".argent-flow-source");
    try {
      // The third way the exclusive create can lose: the marker that beat it is
      // already gone when the loser goes to read it — a racing claim that was
      // cleaned up, or died and was swept, inside that window. Nothing then
      // proves anything about the directory, and an unprovable claim must never
      // be written into: whoever created that marker may still be filling the
      // directory, so copying in would leave unowned bytes in a shared one. So
      // it reads as an occupant with no name and escalates, exactly like an
      // illegible marker does at classify time. Only the race reaches here —
      // `mkdir -p` does not EEXIST on a directory that already exists, and the
      // plain file that would make it EEXIST is diverted to "foreign" by
      // classifyExportDir before takeExportDir is ever called.
      let served = false;
      vi.mocked(fs.writeFile).mockImplementation((async (
        file: unknown,
        data: unknown,
        options: unknown
      ) => {
        if (!served && String(file) === marker) {
          served = true; // only the stem's claim loses; the sibling's really lands
          throw Object.assign(new Error(`EEXIST: file already exists, open '${marker}'`), {
            code: "EEXIST",
          });
        }
        return writeFileSync(file as string, data as never, options as never);
      }) as unknown as typeof fs.writeFile);
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: await writeFile("c.png", "current-bytes") },
      };

      await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

      expect(served).toBe(true); // the create really did lose
      const target = path.join(outDir, `checkout-${pathHash(flowFile)}`);
      expect(step.artifacts?.current).toBe(path.join(target, "home__ios-390x844-current.png"));
      expect(await fs.readFile(step.artifacts?.current as string, "utf8")).toBe("current-bytes");
      expect(await fs.readFile(path.join(target, ".argent-flow-source"), "utf8")).toBe(
        `${flowFile}\n`
      );
      // The stem is bare: created by the mkdir that preceded the lost create,
      // then stepped past — no marker of ours, and none of this run's bytes.
      expect(await fs.readdir(stemDir)).toEqual([]);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledWith(
        `warning: ${stemDir} already holds files from an unknown source; ` +
          `writing this flow's artifacts to ${target} so neither set is overwritten`
      );
    } finally {
      vi.mocked(fs.writeFile).mockRestore();
      errSpy.mockRestore();
    }
  });

  it("claims nothing for failed snapshots that turn out to copy no bytes", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Three shapes that reach the copy loop with a perfectly usable key and
      // still write nothing: an empty artifacts object, roles that are already
      // null, and — the realistic one — a remote handle whose download fails,
      // which the materializer rewrites to null. Claiming before the first byte
      // would leave <output>/checkout and its marker behind for a run holding
      // no artifacts, and that marker is not inert: it makes the stem foreign
      // to every other flow file from then on, so each such run adds another
      // hash-suffixed directory to a reused --output.
      const noRoles: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: {},
      };
      const nulled: StepReport = {
        index: 1,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "list__ios-390x844",
        artifacts: { baseline: null, current: null, diff: null },
      };
      const remote: StepReport = {
        index: 2,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "detail__ios-390x844",
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
      // The server evicted the artifact: the fetch happens, the bytes don't.
      const fetchSpy = vi.fn(async () => new Response("gone", { status: 404 }));

      await exportFailureArtifacts(mkReport([noRoles, nulled, remote]), outDir, flowFile, {
        toolsUrl: "http://tools.invalid",
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1); // the download really was tried
      expect(remote.artifacts?.diff).toBeNull();
      // Not a directory, not a marker, not a warning — --output as it was.
      await expect(fs.access(outDir)).rejects.toThrow();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("rides out an empty marker read instead of scattering to a hash sibling", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // <output>/checkout is this flow's own directory. A concurrent run of the
      // SAME file can catch the marker mid-create: the O_EXCL open publishes the
      // path one syscall before the bytes, so a read landing in between returns
      // "". Reading that as "names nobody" would classify the flow's own
      // directory foreign and split its evidence across a hash sibling for no
      // reason, so an empty read is retried before the marker is written off.
      await fs.mkdir(path.join(outDir, "checkout"), { recursive: true });
      await fs.writeFile(path.join(outDir, "checkout", ".argent-flow-source"), `${flowFile}\n`);
      let served = false;
      vi.mocked(fs.readFile).mockImplementation((async (file: unknown, options: unknown) => {
        if (!served && String(file).endsWith(".argent-flow-source")) {
          served = true; // exactly one read falls inside the window
          return "";
        }
        return readFileSync(file as string, options as never);
      }) as unknown as typeof fs.readFile);
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: await writeFile("c.png", "current-bytes") },
      };

      await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

      expect(served).toBe(true); // the window was actually exercised
      expect(step.artifacts?.current).toBe(
        path.join(outDir, "checkout", "home__ios-390x844-current.png")
      );
      expect(await fs.readdir(outDir)).toEqual(["checkout"]); // no hash sibling
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      vi.mocked(fs.readFile).mockRestore();
      errSpy.mockRestore();
    }
  });

  it("treats a marker that never fills in as an unknown owner, not a free directory", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stemDir = path.join(outDir, "checkout");
    try {
      // The far end of that same window: a marker whose bytes never arrive,
      // because whatever created it died between the O_EXCL open and the write.
      // No number of retries rescues that, and once they run out the marker is
      // illegible — which must mean "someone else's", never "free". Something
      // did claim this directory and may still be filling it, so claiming it
      // again would overwrite exactly the run the marker was created for. The
      // fixture leaves nothing else standing in the way: the directory reads
      // empty, so if the exhausted read reported "no marker" rather than "names
      // nobody" the emptiness probe would hand the directory straight over.
      await fs.mkdir(stemDir, { recursive: true });
      const marker = path.join(stemDir, ".argent-flow-source");
      let reads = 0;
      vi.mocked(fs.readFile).mockImplementation((async (file: unknown, options: unknown) => {
        if (String(file) === marker) {
          reads++; // every attempt falls inside the window, not just the first
          return "";
        }
        return readFileSync(file as string, options as never);
      }) as unknown as typeof fs.readFile);
      const step: StepReport = {
        index: 0,
        kind: "snapshot",
        status: "fail",
        snapshotKey: "home__ios-390x844",
        artifacts: { current: await writeFile("c.png", "current-bytes") },
      };

      await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

      expect(reads).toBe(5); // MARKER_READ_RETRIES + 1: the retries really ran out
      const target = path.join(outDir, `checkout-${pathHash(flowFile)}`);
      expect(step.artifacts?.current).toBe(path.join(target, "home__ios-390x844-current.png"));
      expect(await fs.readFile(step.artifacts?.current as string, "utf8")).toBe("current-bytes");
      expect(await fs.readdir(stemDir)).toEqual([]); // not claimed, not written into
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledWith(
        `warning: ${stemDir} already holds files from an unknown source; ` +
          `writing this flow's artifacts to ${target} so neither set is overwritten`
      );
    } finally {
      vi.mocked(fs.readFile).mockRestore();
      errSpy.mockRestore();
    }
  });

  it.skipIf(!canDenyWrite)(
    "steps past a directory the filesystem refuses to let it claim",
    async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const stemDir = path.join(outDir, "checkout");
      await fs.mkdir(stemDir, { recursive: true });
      await fs.chmod(stemDir, 0o555); // listable and empty, but unwritable
      try {
        // Empty, so the read says "free" — and then the marker create fails with
        // EACCES, leaving the claim unproven. An unproven claim must never be
        // written into (the pre-claim code wrote the marker best-effort and copied
        // in anyway, which would drop unowned bytes into a shared directory), so
        // this escalates exactly like a foreign occupant and says which it is.
        const step: StepReport = {
          index: 0,
          kind: "snapshot",
          status: "fail",
          snapshotKey: "home__ios-390x844",
          artifacts: { current: await writeFile("c.png", "current-bytes") },
        };

        await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

        const target = path.join(outDir, `checkout-${pathHash(flowFile)}`);
        expect(step.artifacts?.current).toBe(path.join(target, "home__ios-390x844-current.png"));
        expect(await fs.readFile(step.artifacts?.current as string, "utf8")).toBe("current-bytes");
        expect(await fs.readdir(stemDir)).toEqual([]); // nothing was forced in
        expect(errSpy).toHaveBeenCalledTimes(1);
        expect(errSpy).toHaveBeenCalledWith(
          `warning: ${stemDir} could not be claimed (EACCES: permission denied, ` +
            `open '${path.join(stemDir, ".argent-flow-source")}'); ` +
            `writing this flow's artifacts to ${target} so neither set is overwritten`
        );
      } finally {
        await fs.chmod(stemDir, 0o755);
        errSpy.mockRestore();
      }
    }
  );

  it.skipIf(!canDenyWrite)(
    "skips the export when no candidate directory can be claimed at all",
    async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await fs.mkdir(outDir, { recursive: true });
      await fs.chmod(outDir, 0o555); // --output itself refuses every mkdir
      try {
        const source = await writeFile("c.png", "current-bytes");
        const step: StepReport = {
          index: 0,
          kind: "snapshot",
          status: "fail",
          snapshotKey: "home__ios-390x844",
          artifacts: { current: source },
        };

        await exportFailureArtifacts(mkReport([step]), outDir, flowFile, ctx);

        // Every rung unclaimable is the give-up case: source path left in place,
        // verdict unchanged, one warning naming the whole span it tried.
        expect(step.artifacts?.current).toBe(source);
        expect(await fs.readdir(outDir)).toEqual([]);
        expect(errSpy).toHaveBeenCalledTimes(1);
        expect(errSpy).toHaveBeenCalledWith(
          `warning: not exporting artifacts for ${flowFile}: no candidate directory from ` +
            `${path.join(outDir, "checkout")} through ` +
            `${path.join(outDir, `checkout-${pathHash(flowFile, 64)}`)} could be claimed without ` +
            `overwriting other files; leaving this run's artifact paths in place so nothing is ` +
            `overwritten`
        );
      } finally {
        await fs.chmod(outDir, 0o755);
        errSpy.mockRestore();
      }
    }
  );
});
