import { describe, expect, it } from "vitest";
import { readCommitTree } from "../../src/utils/react-profiler/debug/dump";
import { preprocess } from "../../src/utils/react-profiler/pipeline/00-preprocess";
import { reduce } from "../../src/utils/react-profiler/pipeline/01-reduce";
import type { SessionContext } from "../../src/utils/react-profiler/types/pipeline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * react-profiler-analyze reads its commit tree back from disk with a bare
 * JSON.parse. JSON.stringify drops undefined properties, so a duration that was
 * non-finite at capture time comes back as an ABSENT key — and `sum += undefined`
 * poisons every downstream statistic (mean, sumSq, totalRenderMs) with NaN.
 */
describe("reduce treats dump-read dropped/null durations as zero", () => {
  it("keeps statistics finite when one commit's selfDuration is absent on disk", async () => {
    const dumped = {
      commits: [
        {
          commitIndex: 0,
          timestamp: 100,
          componentName: "Row",
          actualDuration: null,
          commitDuration: 20,
          didRender: true,
          changeDescription: { props: null, hooks: [0], didHooksChange: true },
        },
        {
          commitIndex: 1,
          timestamp: 200,
          componentName: "Row",
          actualDuration: 5,
          selfDuration: 2,
          commitDuration: 8,
          didRender: true,
          changeDescription: { props: null, hooks: [1], didHooksChange: true },
        },
      ],
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-reduce-null-"));
    const file = path.join(dir, "commits.json");
    fs.writeFileSync(file, JSON.stringify(dumped));
    try {
      const tree = await (readCommitTree as (p: string) => Promise<{ commits: unknown[] }>)(file);
      const out = reduce(
        { commits: preprocess(tree.commits as never), hookNames: new Map() },
        { platform: "ios" } as unknown as SessionContext,
        1000
      );
      const row = out.components.get("Row")!;
      expect(row.n).toBe(2);
      expect(row.sum).toBeCloseTo(2);
      expect(row.sum / row.n).toBeCloseTo(1);
      expect(Number.isFinite(row.sum)).toBe(true);
      expect(Number.isFinite(row.min)).toBe(true);
      expect(Number.isFinite(row.max)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps timestamps finite when absent, without crashing first/last tracking", async () => {
    const dumped = {
      commits: [
        {
          commitIndex: 0,
          componentName: "Col",
          selfDuration: 3,
          actualDuration: 3,
          commitDuration: 5,
          didRender: true,
          changeDescription: { props: null, hooks: null, didHooksChange: false },
        },
      ],
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-reduce-ts-"));
    const file = path.join(dir, "commits.json");
    fs.writeFileSync(file, JSON.stringify(dumped));
    try {
      const tree = await (readCommitTree as (p: string) => Promise<{ commits: unknown[] }>)(file);
      const out = reduce(
        { commits: preprocess(tree.commits as never), hookNames: new Map() },
        { platform: "ios" } as unknown as SessionContext,
        1000
      );
      const col = out.components.get("Col")!;
      expect(col.firstCommitTs).toBe(0);
      expect(col.lastCommitTs).toBe(0);
      expect(col.sum).toBeCloseTo(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
