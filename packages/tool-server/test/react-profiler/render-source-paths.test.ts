import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderProfilingReport } from "../../src/utils/react-profiler/pipeline/05-render";
import type {
  ComponentFinding,
  HotCommitSummary,
} from "../../src/utils/react-profiler/types/output";
import type { SessionContext } from "../../src/utils/react-profiler/types/pipeline";

/**
 * With react-profiler-component-source hidden, the report is the only place that
 * says where a component is, so its path must be one that an agent can open.
 */

const ROOT = "/repo/apps/mobile";

const SESSION_CONTEXT: SessionContext = {
  reactCompilerEnabled: false,
  strictModeEnabled: false,
  buildMode: "dev",
  rnArchitecture: "bridgeless",
  projectRoot: ROOT,
  platform: "ios",
};

const SUMMARY: HotCommitSummary = {
  commitIndex: 0,
  timestampMs: 100,
  totalRenderMs: 100,
  isMargin: false,
  tier: "hot",
  components: [],
  totalComponentCount: 0,
  cpuHotspots: [
    {
      name: "work",
      selfMs: 10,
      totalMs: 10,
      url: "http://localhost:8081/src/index.bundle",
      lineNumber: 7,
    },
  ],
};

function finding(file: string): ComponentFinding {
  return {
    component: "Card",
    renders: 3,
    totalMs: 30,
    avgMs: 10,
    maxMs: 12,
    dominantReason: "props",
    topChangedProps: ["item"],
    topChangedHookNames: [],
    sourceLocation: {
      file,
      line: 4,
      col: 0,
      isMemoized: false,
      hasUseCallback: false,
      hasUseMemo: false,
    },
    sourceSnippet: "function Card() {}",
  };
}

const debugDirs: string[] = [];

afterEach(async () => {
  for (const dir of debugDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function report(file: string): Promise<string> {
  const debugDir = await fs.mkdtemp(join(tmpdir(), "argent-render-source-paths-"));
  debugDirs.push(debugDir);
  const out = await renderProfilingReport({
    hotCommitSummaries: [SUMMARY],
    componentFindings: [finding(file)],
    sessionContext: SESSION_CONTEXT,
    recordingMs: 1000,
    anyRuntimeCompilerDetected: false,
    reactCommits: 1,
    debugDir,
  });
  return out.report;
}

describe("renderProfilingReport — source paths", () => {
  it("gives the path from the project root in every place that names the file", async () => {
    const out = await report(`${ROOT}/src/features/feed/Card/index.tsx`);
    const expected = "`src/features/feed/Card/index.tsx:4`";

    expect(out).toContain(`| ${expected} |`);
    expect(out).toContain(`### \`Card\` — ${expected}`);
    expect(out).toContain(`Source — ${expected}`);
    expect(out).not.toContain("`Card/index.tsx:4`");
  });

  it("keeps the whole path of a file outside the project root", async () => {
    const out = await report("/repo/packages/ui/Card/index.tsx");

    expect(out).toContain("`/repo/packages/ui/Card/index.tsx:4`");
  });

  it("is not fooled by a sibling directory that starts with the root's name", async () => {
    const out = await report("/repo/apps/mobile-web/Card/index.tsx");

    expect(out).toContain("`/repo/apps/mobile-web/Card/index.tsx:4`");
  });

  it("still shortens a CPU frame's bundle url", async () => {
    const out = await report(`${ROOT}/src/Card.tsx`);

    expect(out).toContain("`work` self=10ms total=10ms (src/index.bundle:7)");
    expect(out).not.toContain("http://localhost:8081");
  });
});
