import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectSessionContext } from "../../src/utils/react-profiler/pipeline/session-context";
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

const RENDER_MS = 159.45;
const RENDERS = 4;

function heavyPanelRender(commitIndex: number): DevToolsFiberCommit {
  return {
    commitIndex,
    timestamp: commitIndex * 1000,
    componentName: "HeavyPanel",
    actualDuration: RENDER_MS,
    selfDuration: RENDER_MS,
    commitDuration: RENDER_MS,
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

function rankHeavyPanel(sessionContext: SessionContext) {
  const commits = Array.from({ length: RENDERS }, (_, i) => heavyPanelRender(i));
  const findings = rank(tag(enrich(reduce({ commits }, sessionContext, 10_000))));
  const finding = findings.find((f) => f.component === "HeavyPanel");
  expect(finding, "HeavyPanel must be ranked").toBeDefined();
  return finding!;
}

const projectDirs: string[] = [];

afterEach(async () => {
  for (const dir of projectDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function strictModeProject(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "argent-strict-mode-"));
  projectDirs.push(dir);
  await fs.writeFile(
    join(dir, "index.js"),
    [
      "import { StrictMode } from 'react';",
      "import { AppRegistry } from 'react-native';",
      "import App from './App';",
      "AppRegistry.registerComponent('main', () => () => (",
      "  <StrictMode><App /></StrictMode>",
      "));",
      "",
    ].join("\n")
  );
  return dir;
}

describe("render counts under Strict Mode", () => {
  it("reports every recorded render, with an average that matches the total", async () => {
    const projectRoot = await strictModeProject();
    const sessionContext = await detectSessionContext({
      commitTree: { commits: [] },
      sessionMeta: {
        recordingDurationMs: 10_000,
        deviceId: "DEV",
        platform: "ios",
        rnVersion: "0.81.0",
        projectRoot,
      },
    });
    // Still detected, and still reported as metadata.
    expect(sessionContext.strictModeEnabled).toBe(true);

    const finding = rankHeavyPanel(sessionContext);

    expect(finding.renders).toBe(RENDERS);
    expect(finding.avgMs).toBe(RENDER_MS);
    expect(finding.totalMs).toBe(637.8);
    expect(finding.renders * finding.avgMs).toBeCloseTo(finding.totalMs, 1);
  });

  it("counts the same renders with Strict Mode on and off", () => {
    const base: SessionContext = {
      reactCompilerEnabled: false,
      strictModeEnabled: false,
      buildMode: "dev",
      rnArchitecture: "bridgeless",
      projectRoot: "/tmp/none",
      platform: "ios",
    };
    const off = rankHeavyPanel(base);
    const on = rankHeavyPanel({ ...base, strictModeEnabled: true });
    expect(on).toEqual(off);
  });
});
