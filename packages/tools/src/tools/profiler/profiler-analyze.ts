import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import {
  PROFILER_SESSION_NAMESPACE,
  type ProfilerSessionApi,
  getCachedProfilerData,
} from "../../blueprints/profiler-session";
import type { RawProfilingInput, HermesCpuProfile, DevToolsCommitTree } from "../../profiler/src/types/input";
import { runPipeline } from "../../profiler/src/pipeline/index";
import { buildAstIndex } from "../../profiler/src/pipeline/06-resolve/ast-index";
import { renderProfilingReport } from "../../profiler/src/pipeline/05-render";
import { getDebugDir } from "../../profiler/src/debug/dump";

const annotationSchema = z.object({
  offsetMs: z.number().describe("Milliseconds since profiling started (Date.now() - profileStartWallMs)"),
  label: z.string().describe("Description of the action performed"),
});

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
  project_root: z
    .string()
    .describe("Absolute path to the RN project root for session context detection"),
  platform: z
    .enum(["ios", "android"])
    .default("ios")
    .describe("Target platform"),
  rn_version: z
    .coerce.string()
    .default("unknown")
    .describe('React Native version (e.g. "0.73.4")'),
  annotations: z
    .array(annotationSchema)
    .optional()
    .describe(
      "Optional list of user actions with their time offset from profiling start. " +
      "Compute offsetMs = Date.now() - profileStartWallMs at the time of each action. " +
      "profileStartWallMs is returned by profiler-start as started_at (wall clock)."
    ),
});

export const profilerAnalyzeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  Record<string, unknown>
> = {
  id: "profiler-analyze",
  description: `Analyze stored profiling data and return a markdown performance report.
Returns { report, reportFile, hotCommitsTotal, hotCommitsShown }.
The report is structured around hot React commits (≥16ms absolute floor) with per-commit
render cascades, root cause identification, and a top components table.
Requires profiler-stop to have been called first.
Optional annotations param: provide Array<{offsetMs, label}> to annotate commits with
the user action that preceded them. Compute offsetMs = Date.now() - profileStartWallMs
at each action time (profileStartWallMs is Date.now() captured at profiler-start time).`,
  zodSchema,
  services: (params) => ({
    profilerSession: `${PROFILER_SESSION_NAMESPACE}:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.profilerSession as ProfilerSessionApi;

    let cpuProfile = api.cpuProfile as HermesCpuProfile | null;
    let commitTree: DevToolsCommitTree | null = api.commitTree;
    let detectedArchitecture = api.detectedArchitecture;
    let anyCompilerOptimized = api.anyCompilerOptimized;
    let hotCommitIndices = api.hotCommitIndices;
    let totalReactCommits = api.totalReactCommits;

    if (!cpuProfile && !commitTree) {
      const cached = getCachedProfilerData(api.port);
      if (!cached) {
        throw new Error(
          "No profiling data stored. Call profiler-start → exercise the app → profiler-stop first."
        );
      }
      cpuProfile = cached.cpuProfile;
      commitTree = cached.commitTree;
      detectedArchitecture = cached.detectedArchitecture;
      anyCompilerOptimized = cached.anyCompilerOptimized;
      hotCommitIndices = cached.hotCommitIndices;
      totalReactCommits = cached.totalReactCommits;
    }

    if (!commitTree) {
      commitTree = { commits: [], hookNames: new Map() };
    }

    const recordingDurationMs = cpuProfile
      ? (cpuProfile.endTime - cpuProfile.startTime) / 1000
      : 0;

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

    // Enrich component findings with source locations via AST index
    try {
      const astIndex = await buildAstIndex(params.project_root);
      for (const finding of pipelineOutput.componentFindings) {
        const entry = astIndex.get(finding.component);
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

    const debugDir = await getDebugDir(params.project_root);

    const { report, reportFile, hotCommitsTotal, hotCommitsShown } =
      await renderProfilingReport({
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
    };

    // Warn only when hook was genuinely not installed (null).
    // hotCommitIndices === [] means hook was installed but 0 commits — that's valid, not an error.
    if (commitTree === null || hotCommitIndices === null) {
      result["warning"] =
        "No React commit data — the DevTools hook may not be present in this runtime, or the commit-capture script failed to inject (check profiler-start output for errors).";
    }

    return result;
  },
};
