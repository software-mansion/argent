import { z } from "zod";
import { promises as fsPromises } from "fs";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import { RN_ONLY_TOOL_CAPABILITY } from "../../debugger/debugger-service-ref";
import {
  type ProfilerSessionPaths,
  getCachedProfilerPaths,
} from "../../../blueprints/react-profiler-session";
import type {
  RawProfilingInput,
  HermesCpuProfile,
  DevToolsCommitTree,
} from "../../../utils/react-profiler/types/input";
import { runPipeline } from "../../../utils/react-profiler/pipeline/index";
import { astLookupCandidates } from "../../../utils/react-profiler/component-names";
import { buildAstIndexWithDiagnostics } from "../../../utils/react-profiler/pipeline/06-resolve/ast-index";
import { renderProfilingReport } from "../../../utils/react-profiler/pipeline/05-render";
import {
  readCpuProfile,
  readCommitTree,
  writeDumpCompact,
} from "../../../utils/react-profiler/debug/dump";
import { serializeCpuSampleIndex } from "../../../utils/react-profiler/pipeline/00-cpu-correlate";
import { requireArtifacts, type ArtifactHandle } from "../../../artifacts";
import type { ArtifactKind, ArtifactStore } from "@argent/registry";

/**
 * Register a path as a downloadable artifact so the client gets fetchable bytes
 * rather than a host path it may not be able to open; null/undefined passes
 * through.
 */
async function fileArtifact(
  store: ArtifactStore,
  p: string | null | undefined,
  kind: ArtifactKind
): Promise<ArtifactHandle | null> {
  return p ? store.register({ hostPath: p, kind }) : null;
}

/**
 * Turn each annotation into the `offsetMs` the report renderer wants. A
 * `timestampMs` is a gesture tool's own epoch reading, resolved here against
 * the wall-clock anchor `react-profiler-start` stored with the session — the
 * subtraction the caller used to be asked to do, and the reason `Date.now()`
 * was never a valid substitute: only the tool-server's clock is on both sides.
 */
export function resolveAnnotations(
  annotations: Array<{ timestampMs?: number; offsetMs?: number; label: string }> | undefined,
  profileStartWallMs: number | null
): Array<{ offsetMs: number; label: string }> | undefined {
  if (!annotations) return undefined;
  return annotations.map((a) => {
    if (a.offsetMs !== undefined) return { offsetMs: a.offsetMs, label: a.label };
    // Unreachable through the schema, which requires one of the two.
    const timestampMs = a.timestampMs as number;
    if (profileStartWallMs === null) {
      throw new FailureError(
        `Annotation "${a.label}" gave timestampMs, but this session stored no profiling start to ` +
          `measure it against. Pass offsetMs instead, or re-record the session.`,
        {
          error_code: FAILURE_CODES.REACT_PROFILER_ANALYZE_ANNOTATION_UNANCHORED,
          failure_stage: "react_profiler_analyze_annotations",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    return { offsetMs: timestampMs - profileStartWallMs, label: a.label };
  });
}

const annotationSchema = z
  .object({
    timestampMs: z.coerce
      .number()
      .optional()
      .describe(
        "The `timestampMs` a gesture tool returned, passed through unchanged. Preferred over `offsetMs`: the session's start is read from the stored profile here, so you do not carry it across the session or subtract anything yourself."
      ),
    offsetMs: z.coerce
      .number()
      .optional()
      .describe(
        "Milliseconds since profiling started, for a caller that already holds an offset. Prefer `timestampMs`."
      ),
    label: z.string().describe("Description of the action performed"),
  })
  .refine((a) => (a.timestampMs === undefined) !== (a.offsetMs === undefined), {
    message: "give exactly one of `timestampMs` (preferred) or `offsetMs`",
  });

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .describe(
      "Device logicalDeviceId from debugger-connect (iOS simulator UDID or Android logicalDeviceId)."
    ),
  project_root: z
    .string()
    .describe("Absolute path to the RN project root for session context detection"),
  platform: z.enum(["ios", "android"]).default("ios").describe("Target platform"),
  rn_version: z.coerce.string().default("unknown").describe('React Native version (e.g. "0.73.4")'),
  annotations: z
    .array(annotationSchema)
    .optional()
    .describe(
      "Optional list of user actions to mark on the timeline. Give each one the `timestampMs` " +
        "the tap/swipe tool returned and a `label`; this tool converts it against the profiling " +
        "start it recorded."
    ),
});

export const reactProfilerAnalyzeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  Record<string, unknown>
> = {
  id: "react-profiler-analyze",
  interaction: {
    startedMsg: () => "Analyzing React profile",
    completedMsg: () => "Analyzed React profile",
    failedMsg: ({ failureSignal }) =>
      `Failed to analyze React profile: ${failureSignal.error_code}`,
  },
  description: `Analyze stored profiling data and return a markdown performance report.
Returns { report, reportFile, hotCommitsTotal, hotCommitsShown, sessionFiles }.
The report is structured around hot React commits (≥16ms absolute floor) with per-commit
render cascades, root cause identification, and a top components table.
Raw profiling data is saved to disk with a unique session timestamp for later reload via profiler-load.
After presenting the report, ask the user whether to investigate further (drill-down with
profiler-cpu-query / profiler-commit-query) or implement fixes and re-profile for comparison.
Requires react-profiler-stop to have been called first.
Optional annotations param: provide Array<{timestampMs, label}> to annotate commits with
the user action that preceded them, passing the timestampMs a gesture tool returned as-is.
This tool subtracts the profiling start it recorded, so nothing has to be tracked across the
session. {offsetMs, label} is still accepted for a caller that already holds an offset; give
exactly one of the two per annotation.
Use when the profiling session is complete and you need to interpret the collected data.
Fails if react-profiler-stop has not been called or no profiling data is stored.`,
  zodSchema,
  // RN-only: reads commit data captured via the React DevTools backend, which
  // Chromium does not have.
  capability: RN_ONLY_TOOL_CAPABILITY,
  services: () => ({}),
  async execute(_services, params, ctx) {
    const sessionPaths: ProfilerSessionPaths | undefined = getCachedProfilerPaths(
      params.port,
      params.device_id
    );

    if (!sessionPaths) {
      throw new FailureError(
        "No profiling data stored. Call react-profiler-start → exercise the app → react-profiler-stop first.",
        {
          error_code: FAILURE_CODES.REACT_PROFILER_ANALYZE_NO_DATA,
          failure_stage: "react_profiler_analyze_load_data",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    let cpuProfile: HermesCpuProfile | null = null;
    if (sessionPaths.cpuProfilePath) {
      cpuProfile = await readCpuProfile(sessionPaths.cpuProfilePath);
    }

    let commitTree: DevToolsCommitTree;
    let unattributedByCommit: Array<[number, number, number]> | undefined;
    let profileStartWallMs: number | null = null;
    if (sessionPaths.commitsPath) {
      const onDisk = await readCommitTree(sessionPaths.commitsPath);
      commitTree = { commits: onDisk.commits, hookNames: new Map() };
      if (onDisk.meta?.unattributedByCommit) {
        unattributedByCommit = onDisk.meta.unattributedByCommit;
      }
      profileStartWallMs = onDisk.meta?.profileStartWallMs ?? null;
    } else {
      commitTree = { commits: [], hookNames: new Map() };
    }

    const annotations = resolveAnnotations(params.annotations, profileStartWallMs);

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
        ...(unattributedByCommit && { unattributedByCommit }),
      },
    };

    const pipelineOutput = await runPipeline(input);

    // profiler-cpu-query reads the index back from disk.
    if (pipelineOutput.cpuSampleIndex) {
      const indexPath = await writeDumpCompact(
        sessionPaths.debugDir,
        `react-profiler-${sessionPaths.sessionId}_cpu-index.json`,
        serializeCpuSampleIndex(pipelineOutput.cpuSampleIndex)
      );
      sessionPaths.cpuSampleIndexPath = indexPath;
    }

    try {
      const astIndex = await buildAstIndexWithDiagnostics(params.project_root);
      for (const finding of pipelineOutput.componentFindings) {
        // `finding.component` is the raw DevTools name; the AST index is keyed
        // on bare source identifiers, so without the candidate fallback every
        // Memo/ForwardRef/Forget component loses its source location and the
        // report's File column renders "—".
        const entry = astLookupCandidates(finding.component)
          .map((k) => astIndex.index.get(k))
          .find(Boolean);
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
      /* best-effort */
    }

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
          /* best-effort */
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
      annotations,
      debugDir,
      allClear: pipelineOutput.allClear,
      maxCommitMs: pipelineOutput.maxCommitMs,
    });

    const artifacts = requireArtifacts(ctx);
    const result: Record<string, unknown> = {
      report,
      reportFile: await fileArtifact(artifacts, reportFile, "react-profile-report"),
      hotCommitsTotal,
      hotCommitsShown,
      sessionFiles: {
        sessionId: sessionPaths.sessionId,
        cpuProfile: await fileArtifact(artifacts, sessionPaths.cpuProfilePath, "react-profile-cpu"),
        commits: await fileArtifact(artifacts, sessionPaths.commitsPath, "react-profile-commits"),
      },
    };

    // Only null means no commit data was recorded; [] is the valid "no hot
    // commits" outcome.
    if (hotCommitIndices === null) {
      result["warning"] =
        "No React commit data — the DevTools hook may not be present in this runtime, or the commit-capture script failed to inject (check react-profiler-start output for errors).";
    }

    return result;
  },
};
