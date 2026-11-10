import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderProfilingReport } from "../../src/utils/react-profiler/pipeline/05-render";

/**
 * react-profiler-component-source, react-profiler-cpu-summary and
 * react-profiler-renders are hidden from MCP, so the report must not send the
 * agent to them.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("the report with no hot commit", () => {
  it("names no hidden profiler tool in its next steps", async () => {
    const debugDir = await fs.mkdtemp(path.join(os.tmpdir(), "no-hot-commit-"));
    dirs.push(debugDir);
    const { report } = await renderProfilingReport({
      hotCommitSummaries: [],
      componentFindings: [],
      sessionContext: {
        reactCompilerEnabled: false,
        buildMode: "dev",
        rnArchitecture: "bridgeless",
        projectRoot: "/tmp/fake-project",
        platform: "ios",
      },
      recordingMs: 5000,
      anyRuntimeCompilerDetected: false,
      reactCommits: 12,
      debugDir,
      noHotCommits: true,
      maxCommitMs: 9,
    });

    expect(report).toContain("No commit reached 16ms");
    expect(report).toContain("## Next Steps");
    expect(report).not.toContain("react-profiler-component-source");
    expect(report).not.toContain("react-profiler-cpu-summary");
    expect(report).not.toContain("react-profiler-renders");
  });
});
