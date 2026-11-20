import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { reactProfilerAnalyzeTool } from "../../src/tools/profiler/react/react-profiler-analyze";
import { cacheProfilerPaths } from "../../src/blueprints/react-profiler-session";
import { buildAstIndexWithDiagnostics } from "../../src/utils/react-profiler/pipeline/06-resolve/ast-index";

// The parser's failures cannot be set up with files on disk, so the index is mocked here.
vi.mock("../../src/utils/react-profiler/pipeline/06-resolve/ast-index", () => ({
  buildAstIndexWithDiagnostics: vi.fn(),
}));

let debugDir: string;

beforeEach(() => {
  debugDir = mkdtempSync(join(tmpdir(), "analyze-parser-"));
});

afterEach(() => {
  rmSync(debugDir, { recursive: true, force: true });
});

async function analyze(): Promise<Record<string, unknown>> {
  const commits = [0, 1, 2].map((commitIndex) => ({
    commitIndex,
    timestamp: 100 * commitIndex + 50,
    componentName: "List",
    actualDuration: 30,
    selfDuration: 30,
    commitDuration: 30,
    didRender: true,
    changeDescription: {
      props: ["data"],
      state: null,
      hooks: null,
      context: false,
      didHooksChange: false,
      isFirstMount: false,
    },
    hookTypes: null,
    parentName: null,
    isCompilerOptimized: false,
  }));
  const commitsPath = join(debugDir, "commits.json");
  writeFileSync(commitsPath, JSON.stringify({ commits, meta: {} }));
  cacheProfilerPaths(
    8081,
    {
      sessionId: "parser",
      debugDir,
      cpuProfilePath: null,
      commitsPath,
      cpuSampleIndexPath: null,
      detectedArchitecture: "bridgeless",
      anyCompilerOptimized: false,
      hotCommitIndices: [0, 1, 2],
      totalReactCommits: 3,
    },
    "parser-device"
  );
  const params = reactProfilerAnalyzeTool.zodSchema!.parse({
    device_id: "parser-device",
    project_root: "/some/project",
  });
  const artifacts = {
    register: async ({ kind }: { kind: string }) => ({ id: "x", kind }),
  };
  return (await reactProfilerAnalyzeTool.execute(
    {},
    params as never,
    {
      artifacts,
    } as never
  )) as Record<string, unknown>;
}

describe("the warning when the parser fails", () => {
  it("says tree-sitter could not be loaded", async () => {
    vi.mocked(buildAstIndexWithDiagnostics).mockResolvedValue({
      index: new Map(),
      treeSitterAvailable: false,
      indexedFiles: 0,
    });

    expect((await analyze()).warning).toContain("tree-sitter parser could not be loaded");
  });

  it("warns when every file failed to parse, though files were found", async () => {
    vi.mocked(buildAstIndexWithDiagnostics).mockResolvedValue({
      index: new Map(),
      treeSitterAvailable: true,
      indexedFiles: 40,
    });

    expect((await analyze()).warning).toContain("40 source files");
  });

  it("warns when indexing throws, and still returns the report", async () => {
    vi.mocked(buildAstIndexWithDiagnostics).mockRejectedValue(new Error("stack overflow"));

    const result = await analyze();

    expect(result.warning).toContain("Reading the project's source failed");
    expect(result.report).toContain("`List`");
  });
});
