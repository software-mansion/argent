import { describe, it, expect } from "vitest";
import {
  buildCpuSampleIndex,
  queryCpuWindow,
  serializeCpuSampleIndex,
  deserializeCpuSampleIndex,
} from "../../src/utils/react-profiler/pipeline/00-cpu-correlate";
import type { HermesCpuProfile } from "../../src/utils/react-profiler/types/input";

/**
 * Issue #619. Two defects made `profiler-cpu-query` unusable for the workflow it
 * documents ("read a slow commit, then query its window"):
 *
 *  - self-time was `(endMs - startMs) / sampleCount × hits`, i.e. the REQUESTED
 *    window's duration apportioned by hit share, so asking about a wider range
 *    multiplied every number without the sample data changing;
 *  - sample timestamps were displaced by the first hot commit's timestamp,
 *    because the code assumed the profile began when that commit happened.
 *
 * Real Hermes profiles carry a since-boot `startTime` (~1.28e12 µs) and genuinely
 * non-uniform `timeDeltas` (0–36.6ms around a 13.1ms median), so the fixtures
 * here use a since-boot start time — any reintroduction of absolute timestamps
 * fails loudly rather than subtly.
 */

const SINCE_BOOT_START_US = 1_276_275_277_894;

const NODES = [
  { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2, 3] },
  { id: 2, callFrame: { functionName: "work", url: "app.js", lineNumber: 10 }, children: [] },
  { id: 3, callFrame: { functionName: "other", url: "app.js", lineNumber: 20 }, children: [] },
];

function makeProfile(deltasUs: number[], nodeIds: number[]): HermesCpuProfile {
  const total = deltasUs.reduce((a, b) => a + b, 0);
  return {
    nodes: NODES,
    samples: nodeIds,
    timeDeltas: deltasUs,
    startTime: SINCE_BOOT_START_US,
    endTime: SINCE_BOOT_START_US + total,
  } as unknown as HermesCpuProfile;
}

/** 1000 samples one millisecond apart, all doing `work`. Truth: 1000ms. */
function uniformWorkProfile(): HermesCpuProfile {
  // timeDeltas[0] = 0 matches every real Hermes profile inspected: `startTime`
  // is the first sample's timestamp, so no time elapsed before it.
  const deltas = [0, ...new Array(1000).fill(1000)];
  return makeProfile(deltas, new Array(1001).fill(2));
}

function selfOf(hotspots: { name: string; selfMs: number }[], name: string): number | undefined {
  return hotspots.find((h) => h.name === name)?.selfMs;
}

describe("queryCpuWindow — self-time describes the samples, not the question", () => {
  it("returns the same self-time however wide the requested window is", () => {
    // THE headline invariant. Pre-fix these returned 1000 / 2000 / 10000 /
    // ~2000000 for identical sample data.
    const index = buildCpuSampleIndex(uniformWorkProfile());

    for (const [start, end] of [
      [0, 1000],
      [0, 2000],
      [0, 10_000],
      [-1_000_000, 1_000_000],
    ] as const) {
      const res = queryCpuWindow(index, start, end, 5);
      expect(selfOf(res.hotspots, "work")).toBe(1000);
    }
  });

  it("partitions a window rather than scaling it", () => {
    // Alternating work/other, 1ms each. Any sub-window splits 50/50 and the
    // window's own width never appears in the output.
    const ids = [2];
    const deltas = [0];
    for (let i = 0; i < 1000; i++) {
      deltas.push(1000);
      ids.push(i % 2 === 0 ? 3 : 2);
    }
    const index = buildCpuSampleIndex(makeProfile(deltas, ids));

    const tenth = queryCpuWindow(index, 0, 100, 5);
    expect(selfOf(tenth.hotspots, "work")).toBe(50);
    expect(selfOf(tenth.hotspots, "other")).toBe(50);

    const whole = queryCpuWindow(index, 0, 1000, 5);
    expect(selfOf(whole.hotspots, "work")).toBe(500);
    expect(selfOf(whole.hotspots, "other")).toBe(500);
  });

  it("never reports more CPU than the window can physically contain", () => {
    // A sample stands for the interval that ENDED at it, so a window cutting
    // through one must count only the part inside. Without clipping, a 45ms
    // commit could be credited with more than 45ms of work.
    const index = buildCpuSampleIndex(makeProfile([0, 20_000, 20_000, 20_000], [2, 2, 2, 2]));

    const res = queryCpuWindow(index, 25, 35, 5);

    expect(res.coveredMs).toBeCloseTo(10, 6);
    expect(selfOf(res.hotspots, "work")).toBeCloseTo(10, 2);
  });

  it("is additive: adjoining windows sum to their union", () => {
    // Follows from clipping, and is what lets a caller trust a per-commit
    // breakdown against a whole-session total.
    const index = buildCpuSampleIndex(uniformWorkProfile());

    const a = selfOf(queryCpuWindow(index, 0, 400, 5).hotspots, "work")!;
    const b = selfOf(queryCpuWindow(index, 400, 1000, 5).hotspots, "work")!;
    const whole = selfOf(queryCpuWindow(index, 0, 1000, 5).hotspots, "work")!;

    expect(a + b).toBeCloseTo(whole, 6);
  });

  it("weights each sample by its own interval, not by an average", () => {
    // `slow` is caught twice across 20ms gaps, `fast` twice across 1ms gaps.
    // An average would call them equal; they differ 20×.
    const index = buildCpuSampleIndex(
      makeProfile([0, 1000, 1000, 20_000, 20_000], [2, 2, 2, 3, 3])
    );

    const res = queryCpuWindow(index, 0, 100_000, 5);

    expect(selfOf(res.hotspots, "work")).toBeCloseTo(2, 2);
    expect(selfOf(res.hotspots, "other")).toBeCloseTo(40, 2);
  });
});

describe("buildCpuSampleIndex — sample times are ms since profiling started", () => {
  it("rebases a since-boot start time to zero", () => {
    // Pre-fix this depended on a commit timestamp and could be displaced by it.
    const index = buildCpuSampleIndex(uniformWorkProfile());

    expect(index.intervalStartsMs[0]).toBe(0);
    expect(index.timestampsMs[0]).toBe(0);
    expect(index.timestampsMs[index.timestampsMs.length - 1]).toBeCloseTo(1000, 6);
  });

  it("does not depend on commit data at all", () => {
    // The displacement bug came from inferring an offset out of the first hot
    // commit's timestamp — a value that can be many seconds into a session. The
    // index no longer accepts one, so no such inference is possible.
    expect(buildCpuSampleIndex.length).toBe(1);
  });

  it("covers the profile's own reported duration, to within one interval", () => {
    // Σ timeDeltas is short of endTime - startTime by the final unsampled
    // interval — 899µs on the reporter's real 25.1s profile. Exact equality
    // would be wrong to assert.
    const profile = uniformWorkProfile();
    const index = buildCpuSampleIndex(profile);
    const res = queryCpuWindow(index, -1e9, 1e9, 50);
    const reportedMs = (profile.endTime - profile.startTime) / 1000;

    expect(res.coveredMs).toBeLessThanOrEqual(reportedMs);
    expect(reportedMs - res.coveredMs).toBeLessThanOrEqual(1);
  });

  it("treats missing, negative and non-finite deltas as zero", () => {
    const profile = makeProfile([0, 1000, -5000, Number.NaN, 1000], [2, 2, 2, 2, 2]);
    const index = buildCpuSampleIndex(profile);

    const res = queryCpuWindow(index, -1e9, 1e9, 5);

    expect(Number.isFinite(res.coveredMs)).toBe(true);
    expect(selfOf(res.hotspots, "work")).toBeCloseTo(2, 6);
  });
});

describe("queryCpuWindow — the different ways of finding nothing", () => {
  it("reports idle coverage rather than pretending the window was empty", () => {
    // The dominant real case: on the reported session 99% of samples were
    // idle, so a window can be fully covered and still rank nothing. Saying
    // "no samples" there would be false, and would read as "this was cheap".
    const index = buildCpuSampleIndex(makeProfile([0, 10_000, 10_000], [1, 1, 1]));

    const res = queryCpuWindow(index, 0, 20, 5);

    expect(res.hotspots).toHaveLength(0);
    expect(res.samplesInWindow).toBe(2);
    expect(res.coveredMs).toBeCloseTo(20, 6);
    expect(res.idleMs).toBeCloseTo(20, 6);
  });

  it("distinguishes a window outside the recorded range", () => {
    const index = buildCpuSampleIndex(uniformWorkProfile());

    const res = queryCpuWindow(index, 50_000, 60_000, 5);

    expect(res.samplesInWindow).toBe(0);
    expect(res.coveredMs).toBe(0);
    expect(res.sampleRangeMs.end).toBeCloseTo(1000, 6);
  });

  it("reports an empty profile as having no sampled range at all", () => {
    const res = queryCpuWindow(buildCpuSampleIndex(makeProfile([], [])), 0, 1000, 5);

    expect(res.samplesInWindow).toBe(0);
    expect(res.sampleRangeMs).toEqual({ start: 0, end: 0 });
  });
});

describe("serialized index", () => {
  it("round-trips to identical query results", () => {
    const index = buildCpuSampleIndex(uniformWorkProfile());
    const restored = deserializeCpuSampleIndex(
      JSON.parse(JSON.stringify(serializeCpuSampleIndex(index)))
    );

    expect(queryCpuWindow(restored, 0, 500, 5)).toEqual(queryCpuWindow(index, 0, 500, 5));
  });

  it("rejects a pre-fix index instead of answering from displaced timestamps", () => {
    // A v1 file on disk holds timestamps shifted by the old clock heuristic and
    // no interval starts. Reusing one would reproduce the bug from cache; the
    // caller catches this and rebuilds from the raw profile, which is retained.
    const legacy = {
      timestampsMs: [1, 2, 3],
      sampleNodeIds: [2, 2, 2],
      nodes: NODES,
      durationMs: 3,
    };

    expect(() => deserializeCpuSampleIndex(legacy as never)).toThrow(/unsupported/i);
  });

  it("rejects a truncated index rather than silently reading zero samples", () => {
    // `new Float64Array(undefined)` is empty, so an unvalidated read would turn
    // a corrupt file into "this session had no CPU activity", permanently.
    expect(() => deserializeCpuSampleIndex({ version: 2 } as never)).toThrow(/unsupported/i);
  });
});
