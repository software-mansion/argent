import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderProfilingReport } from "../../src/utils/react-profiler/pipeline/05-render";

/**
 * react-profiler-component-source is hidden from MCP. What the agent gets
 * instead: the analyze report's own source locations.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("the all-clear report", () => {
  it("advises a memoization check without naming component-source", async () => {
    const debugDir = await fs.mkdtemp(path.join(os.tmpdir(), "all-clear-"));
    dirs.push(debugDir);
    const { report } = await renderProfilingReport({
      hotCommitSummaries: [],
      componentFindings: [],
      sessionContext: {
        reactCompilerEnabled: false,
        strictModeEnabled: false,
        buildMode: "dev",
        rnArchitecture: "bridgeless",
        projectRoot: "/tmp/fake-project",
        platform: "ios",
      },
      recordingMs: 5000,
      anyRuntimeCompilerDetected: false,
      reactCommits: 12,
      debugDir,
      allClear: true,
      maxCommitMs: 9,
    });

    expect(report).toContain("All clear");
    expect(report).toContain("check that memoization is in place");
    expect(report).not.toContain("react-profiler-component-source");
  });
});
