import { describe, expect, it } from "vitest";
import { reduce } from "../../src/utils/react-profiler/pipeline/01-reduce";
import { enrich } from "../../src/utils/react-profiler/pipeline/02-enrich";
import { tag } from "../../src/utils/react-profiler/pipeline/03-tag";
import { rank } from "../../src/utils/react-profiler/pipeline/04-rank";
import type { DevToolsFiberCommit } from "../../src/utils/react-profiler/types/input";
import type { SessionContext } from "../../src/utils/react-profiler/types/pipeline";

/**
 * React DevTools records one entry per render. Under Strict Mode a dev build
 * calls each render function twice, but both calls land inside that one
 * entry's duration; they never add a second entry. The pipeline used to halve
 * the count whenever index.js mentioned StrictMode. Measured on a device: 4 taps,
 * 4 HeavyPanel renders of ~160 ms each in the commit data, and the report said
 * "Renders 2, Total 637.8 ms, Avg 159.44 ms", which do not add up.
 */

const HEAVY_MS = 159.45;
// Below rank's max-duration gate, so only the render count can admit a component.
const SHORT_MS = 5;

function render(commitIndex: number, durationMs: number): DevToolsFiberCommit {
  return {
    commitIndex,
    timestamp: commitIndex * 1000,
    componentName: "Panel",
    actualDuration: durationMs,
    selfDuration: durationMs,
    commitDuration: durationMs,
    didRender: true,
    changeDescription: {
      props: ["count"],
      state: null,
      hooks: null,
      context: null,
      didHooksChange: false,
      isFirstMount: false,
    },
    hookTypes: null,
    parentName: "App",
    isCompilerOptimized: false,
  };
}

// The cast keeps the flag the removed halving read, so a halving that returns on it fails here.
const SESSION = {
  reactCompilerEnabled: false,
  buildMode: "dev",
  rnArchitecture: "bridgeless",
  projectRoot: "/tmp/none",
  platform: "ios",
  strictModeEnabled: true,
} as SessionContext;

function rankPanel(renders: number, durationMs: number, session = SESSION) {
  const commits = Array.from({ length: renders }, (_, i) => render(i, durationMs));
  const findings = rank(tag(enrich(reduce({ commits }, session, 10_000))));
  return findings.find((f) => f.component === "Panel");
}

describe("render counts", () => {
  it("reports every recorded render, with an average that matches the total", () => {
    const finding = rankPanel(4, HEAVY_MS)!;

    expect(finding.renders).toBe(4);
    expect(finding.avgMs).toBe(HEAVY_MS);
    expect(finding.totalMs).toBe(637.8);
    expect(finding.renders * finding.avgMs).toBeCloseTo(finding.totalMs, 1);
  });

  it("ranks a short component from its third recorded render", () => {
    expect(rankPanel(2, SHORT_MS)).toBeUndefined();
    expect(rankPanel(3, SHORT_MS)?.renders).toBe(3);
  });

  it("suspects a compiler bailout from the sixth recorded render", () => {
    const compiled = { ...SESSION, reactCompilerEnabled: true };
    expect(rankPanel(5, SHORT_MS, compiled)?.compilerBailoutSuspected).toBeUndefined();
    expect(rankPanel(6, SHORT_MS, compiled)?.compilerBailoutSuspected).toBe(true);
  });
});
