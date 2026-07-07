import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exportFailureArtifacts, type FlowReport, type StepReport } from "../src/flow.js";

let tmpDir: string;
let outDir: string;

async function writeFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content);
  return p;
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

    await exportFailureArtifacts(mkReport([step]), outDir);

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

    await exportFailureArtifacts(mkReport([seeded]), outDir);

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

    await exportFailureArtifacts(mkReport([step]), outDir);

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

    await exportFailureArtifacts(mkReport([withNull, keyless]), outDir);

    expect(withNull.artifacts?.baseline).toBeNull();
    expect(withNull.artifacts?.current).toBe(
      path.join(outDir, "checkout", "home__ios-390x844-current.png")
    );
    // No snapshotKey and no baseline to derive one from — nothing written.
    expect(keyless.artifacts?.current).toBe(current);
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

      await exportFailureArtifacts(mkReport([step]), outDir);

      expect(step.artifacts?.diff).toBe(gone);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("warning: could not write"));
    } finally {
      errSpy.mockRestore();
    }
  });
});
