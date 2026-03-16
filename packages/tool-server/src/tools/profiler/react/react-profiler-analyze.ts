import { z } from "zod";
import { promises as fsPromises } from "fs";
import type { ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  getCachedProfilerData,
} from "../../../blueprints/react-profiler-session";
import type {
  RawProfilingInput,
  HermesCpuProfile,
  DevToolsCommitTree,
} from "../../../utils/react-profiler/types/input";
import { runPipeline } from "../../../utils/react-profiler/pipeline/index";
import { buildAstIndexWithDiagnostics } from "../../../utils/react-profiler/pipeline/06-resolve/ast-index";
import { renderProfilingReport } from "../../../utils/react-profiler/pipeline/05-render";
import { getDebugDir, writeDump } from "../../../utils/react-profiler/debug/dump";

const annotationSchema = z.object({
  offsetMs: z.coerce
    .number()
    .describe(
      "Milliseconds since profiling started. Compute as: tapTimestampMs - startedAtEpochMs, using the timestampMs returned by tap/swipe and the startedAtEpochMs returned by react-profiler-start.",
    ),
  label: z.string().describe("Description of the action performed"),
});

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  project_root: z
    .string()
    .describe(
      "Absolute path to the RN project root for session context detection",
    ),
  platform: z
    .enum(["ios", "android"])
    .default("ios")
    .describe("Target platform"),
  rn_version: z.coerce
    .string()
    .default("unknown")
    .describe('React Native version (e.g. "0.73.4")'),
  annotations: z
    .array(annotationSchema)
    .optional()
    .describe(
      "Optional list of user actions with their time offset from profiling start. " +
        "Compute offsetMs = tapTimestampMs - startedAtEpochMs, where tapTimestampMs comes from the tap/swipe tool return value and startedAtEpochMs comes from react-profiler-start return value.",
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
          "No profiling data stored. Call react-profiler-start → exercise the app → react-profiler-stop first.",
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

    // Cache the cpuSampleIndex for subsequent query tool calls
    if (pipelineOutput.cpuSampleIndex) {
      const snapshot = getCachedProfilerData(api.port);
      if (snapshot) {
        snapshot.cpuSampleIndex = pipelineOutput.cpuSampleIndex;
      }
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
      }),
    );

    const debugDir = await getDebugDir(params.project_root);

    // Persist raw profiling data so it can be reloaded by profiler-load
    const sessionTs = new Date()
      .toISOString()
      .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
      .slice(0, 15);
    const cpuFile = cpuProfile
      ? await writeDump(debugDir, `react-profiler-${sessionTs}_cpu.json`, cpuProfile)
      : null;
    const commitsFile = await writeDump(
      debugDir,
      `react-profiler-${sessionTs}_commits.json`,
      {
        commits: commitTree.commits,
        meta: {
          detectedArchitecture,
          anyCompilerOptimized,
          hotCommitIndices,
          totalReactCommits,
          profileStartWallMs: api.profileStartWallMs,
        },
      },
    );

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
      sessionFiles: {
        sessionId: sessionTs,
        cpuProfile: cpuFile,
        commits: commitsFile,
      },
    };

    // Warn only when hook was genuinely not installed (null).
    // hotCommitIndices === [] means hook was installed but 0 commits — that's valid, not an error.
    if (commitTree === null || hotCommitIndices === null) {
      result["warning"] =
        "No React commit data — the DevTools hook may not be present in this runtime, or the commit-capture script failed to inject (check react-profiler-start output for errors).";
    }

    return result;
  },
};
