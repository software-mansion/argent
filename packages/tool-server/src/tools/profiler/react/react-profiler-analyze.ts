import { z } from "zod";
import { promises as fsPromises } from "fs";
import type { ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  type ProfilerSessionPaths,
  getCachedProfilerPaths,
} from "../../../blueprints/react-profiler-session";
import type {
  RawProfilingInput,
  HermesCpuProfile,
  DevToolsCommitTree,
} from "../../../utils/react-profiler/types/input";
import { runPipeline } from "../../../utils/react-profiler/pipeline/index";
import { buildAstIndexWithDiagnostics } from "../../../utils/react-profiler/pipeline/06-resolve/ast-index";
import { renderProfilingReport } from "../../../utils/react-profiler/pipeline/05-render";
import {
  readCpuProfile,
  readCommitTree,
  writeDumpCompact,
} from "../../../utils/react-profiler/debug/dump";
import { serializeCpuSampleIndex } from "../../../utils/react-profiler/pipeline/00-cpu-correlate";

const annotationSchema = z.object({
  offsetMs: z.coerce
    .number()
    .describe(
      "Milliseconds since profiling started. Compute as: tapTimestampMs - startedAtEpochMs, using the timestampMs returned by tap/swipe and the startedAtEpochMs returned by react-profiler-start."
    ),
  label: z.string().describe("Description of the action performed"),
});

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  project_root: z
    .string()
    .describe("Absolute path to the RN project root for session context detection"),
  platform: z.enum(["ios", "android"]).default("ios").describe("Target platform"),
  rn_version: z.coerce.string().default("unknown").describe('React Native version (e.g. "0.73.4")'),
  annotations: z
    .array(annotationSchema)
    .optional()
    .describe(
      "Optional list of user actions with their time offset from profiling start. " +
        "Compute offsetMs = tapTimestampMs - startedAtEpochMs, where tapTimestampMs comes from the tap/swipe tool return value and startedAtEpochMs comes from react-profiler-start return value."
    ),
});

export const reactProfilerAnalyzeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  Record<string, unknown>
> = {
  id: "react-profiler-analyze",
  description: `Analyze stored profiling data and return a markdown performance report.
Returns { report, reportFile, hotCommitsTotal, hotCommitsShown, sessionFiles }.
The report is structured around hot React commits (≥16ms absolute floor) with per-commit
render cascades, root cause identification, and a top components table.
Raw profiling data is saved to disk with a unique session timestamp for later reload via profiler-load.
After presenting the report, ask the user whether to investigate further (drill-down with
profiler-cpu-query / profiler-commit-query) or implement fixes and re-profile for comparison.
Requires react-profiler-stop to have been called first.
Optional annotations param: provide Array<{offsetMs, label}> to annotate commits with
the user action that preceded them. Compute offsetMs = tapTimestampMs - startedAtEpochMs
where tapTimestampMs is the timestampMs returned by the tap/swipe tool and startedAtEpochMs
is returned by react-profiler-start.`,
  zodSchema,
  services: (params) => ({
    profilerSession: `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.profilerSession as ReactProfilerSessionApi;

    // Resolve session paths from session or cache
    const sessionPaths: ProfilerSessionPaths | undefined =
      api.sessionPaths ?? getCachedProfilerPaths(api.port) ?? undefined;

    if (!sessionPaths) {
      throw new Error(
        "No profiling data stored. Call react-profiler-start → exercise the app → react-profiler-stop first."
      );
    }

    // Read profiling data from disk (transient — GC'd when function returns)
    let cpuProfile: HermesCpuProfile | null = null;
    if (sessionPaths.cpuProfilePath) {
      cpuProfile = await readCpuProfile(sessionPaths.cpuProfilePath);
    }

    let commitTree: DevToolsCommitTree;
    if (sessionPaths.commitsPath) {
      const onDisk = await readCommitTree(sessionPaths.commitsPath);
      commitTree = { commits: onDisk.commits, hookNames: new Map() };
    } else {
      commitTree = { commits: [], hookNames: new Map() };
    }

    const { detectedArchitecture, anyCompilerOptimized, hotCommitIndices, totalReactCommits } =
      sessionPaths;

    const recordingDurationMs = cpuProfile ? (cpuProfile.endTime - cpuProfile.startTime) / 1000 : 0;

    const input: RawProfilingInput = {
      ...(cpuProfile !== null && { flamegraph: cpuProfile }),
      commitTree,
      sessionMeta: {
        recordingDurationMs,
        deviceId: "simulator",
        platform: params.platform,
        rnVersion: params.rn_version,
        projectRoot: params.project_root,
        ...(detectedArchitecture !== null && {
          detectedArchitecture,
        }),
        ...(anyCompilerOptimized !== null && {
          anyCompilerOptimized,
        }),
        ...(hotCommitIndices !== null && {
          hotCommitIndices,
        }),
        ...(totalReactCommits !== null && {
          totalReactCommits,
        }),
      },
    };

    const pipelineOutput = await runPipeline(input);

    // Serialize CpuSampleIndex to disk for subsequent query tool calls
    if (pipelineOutput.cpuSampleIndex) {
      const indexPath = await writeDumpCompact(
        sessionPaths.debugDir,
        `react-profiler-${sessionPaths.sessionId}_cpu-index.json`,
        serializeCpuSampleIndex(pipelineOutput.cpuSampleIndex)
      );
      sessionPaths.cpuSampleIndexPath = indexPath;
    }

    // Enrich component findings with source locations via AST index
    try {
      const astIndex = await buildAstIndexWithDiagnostics(params.project_root);
      for (const finding of pipelineOutput.componentFindings) {
        const entry = astIndex.index.get(finding.component);
        if (entry) {
          finding.sourceLocation = {
            file: entry.file,
            line: entry.line,
            col: entry.col,
            isMemoized: entry.isMemoized,
            hasUseCallback: entry.hasUseCallback,
            hasUseMemo: entry.hasUseMemo,
          };
        }
      }
    } catch {
      // non-fatal — AST index may fail if tree-sitter native bindings aren't compiled
    }

    // Attach source snippets to the top 5 findings by totalMs
    const top5 = pipelineOutput.componentFindings
      .slice()
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 5);
    await Promise.all(
      top5.map(async (finding) => {
        if (!finding.sourceLocation?.file || !finding.sourceLocation?.line) return;
        try {
          const raw = await fsPromises.readFile(finding.sourceLocation.file, "utf8");
          const allLines = raw.split("\n");
          const startLine = Math.max(0, finding.sourceLocation.line - 2);
          const endLine = Math.min(allLines.length, startLine + 50);
          finding.sourceSnippet = allLines.slice(startLine, endLine).join("\n");
        } catch {
          // non-fatal — file may not be readable
        }
      })
    );

    const debugDir = sessionPaths.debugDir;

    const { report, reportFile, hotCommitsTotal, hotCommitsShown } = await renderProfilingReport({
      hotCommitSummaries: pipelineOutput.hotCommitSummaries,
      componentFindings: pipelineOutput.componentFindings,
      sessionContext: pipelineOutput.sessionContext,
      recordingMs: pipelineOutput.recordingMs,
      anyRuntimeCompilerDetected: pipelineOutput.anyRuntimeCompilerDetected,
      reactCommits: pipelineOutput.reactCommits,
      annotations: params.annotations,
      debugDir,
      allClear: pipelineOutput.allClear,
      maxCommitMs: pipelineOutput.maxCommitMs,
    });

    const result: Record<string, unknown> = {
      report,
      reportFile,
      hotCommitsTotal,
      hotCommitsShown,
      sessionFiles: {
        sessionId: sessionPaths.sessionId,
        cpuProfile: sessionPaths.cpuProfilePath,
        commits: sessionPaths.commitsPath,
      },
    };

    // Warn only when hook was genuinely not installed (null).
    // hotCommitIndices === [] means hook was installed but 0 commits — that's valid, not an error.
    if (hotCommitIndices === null) {
      result["warning"] =
        "No React commit data — the DevTools hook may not be present in this runtime, or the commit-capture script failed to inject (check react-profiler-start output for errors).";
    }

    return result;
  },
};
