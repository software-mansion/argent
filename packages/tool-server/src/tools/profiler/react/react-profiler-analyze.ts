import { z } from "zod";
import { promises as fsPromises } from "fs";
import { relative, isAbsolute } from "path";
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
import { metroPort, metroPortField } from "../../../utils/debugger/metro-port";
import {
  parseRenderSummary,
  selectFrequentRerenders,
  type RenderSummary,
} from "../../../utils/react-profiler/render-summary";
import {
  createComponentOriginClassifier,
  type ComponentSourceIndex,
} from "../../../utils/react-profiler/component-origin";

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
 * The bundle URL in a Hermes profile names the platform that ran it, which is
 * stronger than the `platform` parameter: agents may omit that on Android.
 */
function recordedPlatform(profile: HermesCpuProfile | null): "ios" | "android" | undefined {
  for (const node of profile?.nodes ?? []) {
    const match = /[?&]platform=(ios|android)\b/.exec(node.callFrame.url);
    if (match) return match[1] as "ios" | "android";
  }
  return undefined;
}

async function resolvedPath(path: string): Promise<string> {
  return fsPromises.realpath(path).catch(() => path);
}

/** True when neither path holds the other, so they are not one project (or a monorepo around it). */
async function unrelatedPaths(a: string, b: string): Promise<boolean> {
  const [from, to] = await Promise.all([resolvedPath(a), resolvedPath(b)]);
  const outside = (rel: string) => rel.startsWith("..") || isAbsolute(rel);
  return outside(relative(from, to)) && outside(relative(to, from));
}

const annotationSchema = z.object({
  offsetMs: z.coerce
    .number()
    .describe(
      "Milliseconds since profiling started: tapTimestampMs - startedAtEpochMs, where tapTimestampMs is the timestampMs a tap/swipe tool returned and startedAtEpochMs is the value react-profiler-start returned."
    ),
  label: z.string().describe("Description of the action performed"),
});

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device logicalDeviceId from debugger-connect (iOS simulator UDID or Android logicalDeviceId)."
    ),
  project_root: z
    .string()
    .describe("Absolute path to the RN project root for session context detection"),
  platform: z.enum(["ios", "android"]).optional().describe("Target platform"),
  rn_version: z.coerce.string().default("unknown").describe('React Native version (e.g. "0.73.4")'),
  annotations: z
    .array(annotationSchema)
    .optional()
    .describe(
      "User actions to annotate the report's commits with: each commit shows the action that preceded it."
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
Use when the profiling session is complete and you need to interpret the collected data.
Fails if react-profiler-stop has not been called or no profiling data is stored.`,
  zodSchema,
  interaction: {
    startedMsg: () => "Analyzing React profile",
    completedMsg: () => "Analyzed React profile",
    failedMsg: ({ failureSignal }) =>
      `Failed to analyze React profile: ${failureSignal.error_code}`,
  },
  // RN-only: reads commit data captured via the React DevTools backend, which
  // Chromium does not have.
  capability: RN_ONLY_TOOL_CAPABILITY,
  services: () => ({}),
  async execute(_services, params, ctx) {
    const sessionPaths: ProfilerSessionPaths | undefined = getCachedProfilerPaths(
      metroPort(params),
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
    let metroRoot: string | undefined;
    // Null for sessions saved before stop wrote it. With no hot commit the report
    // then says commits under 16ms were not measured; with hot commits it only
    // leaves out the lines that need the summary.
    let renderSummary: RenderSummary | null = null;
    if (sessionPaths.commitsPath) {
      const onDisk = await readCommitTree(sessionPaths.commitsPath);
      commitTree = { commits: onDisk.commits, hookNames: new Map() };
      if (onDisk.meta?.unattributedByCommit) {
        unattributedByCommit = onDisk.meta.unattributedByCommit;
      }
      metroRoot = onDisk.meta?.projectRoot || undefined;
      renderSummary = parseRenderSummary(onDisk.meta?.renderSummary);
    } else {
      commitTree = { commits: [], hookNames: new Map() };
    }

    const { detectedArchitecture, anyCompilerOptimized, hotCommitIndices, totalReactCommits } =
      sessionPaths;

    const platform = recordedPlatform(cpuProfile) ?? params.platform;
    const recordingDurationMs = cpuProfile ? (cpuProfile.endTime - cpuProfile.startTime) / 1000 : 0;

    const input: RawProfilingInput = {
      ...(cpuProfile !== null && { flamegraph: cpuProfile }),
      commitTree,
      sessionMeta: {
        recordingDurationMs,
        deviceId: "simulator",
        platform: platform ?? "ios",
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
        // [] means stop ran and no commit reached the floor; null means no commit data.
        noHotCommits: hotCommitIndices !== null && hotCommitIndices.length === 0,
        ...(renderSummary && { maxCommitMs: renderSummary.maxCommitMs }),
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

    // The index costs seconds on a large app, so build it only when the report
    // uses it: for the File column of findings, or to tell app components from
    // library ones in the frequent re-render rows. Names alone rule out most
    // rows, which keeps quiet sessions fast.
    const needsSourceIndex =
      pipelineOutput.componentFindings.length > 0 ||
      (renderSummary !== null &&
        selectFrequentRerenders(renderSummary, createComponentOriginClassifier(null)).length > 0);
    let sourceIndex: ComponentSourceIndex | null = null;
    let sourceWarning: string | undefined;
    let sourceRoot = params.project_root;
    try {
      let astIndex = needsSourceIndex
        ? await buildAstIndexWithDiagnostics(sourceRoot, platform)
        : null;
      if (astIndex && astIndex.index.size === 0 && metroRoot && metroRoot !== sourceRoot) {
        // Over a link the caller's path is a client path, and Metro's is on this host.
        const fromMetro = await buildAstIndexWithDiagnostics(metroRoot, platform);
        if (fromMetro.index.size > 0) {
          astIndex = fromMetro;
          sourceRoot = metroRoot;
          sourceWarning = `project_root "${params.project_root}" holds no components on the tool-server host, so the File column comes from Metro's project root "${metroRoot}".`;
        }
      }
      if (astIndex?.treeSitterAvailable) sourceIndex = astIndex.index;
      for (const finding of pipelineOutput.componentFindings) {
        // `finding.component` is the raw DevTools name; the AST index is keyed
        // on bare source identifiers, so without the candidate fallback every
        // Memo/ForwardRef/Forget component loses its source location and the
        // report's File column renders "—".
        const entry = astLookupCandidates(finding.component)
          .map((k) => astIndex?.index.get(k))
          .find(Boolean);
        if (entry) {
          finding.sourceLocation = {
            file: entry.file,
            line: entry.line,
            col: entry.col,
            isMemoized: entry.isMemoized,
            hasUseCallback: entry.hasUseCallback,
            hasUseMemo: entry.hasUseMemo,
            ...(entry.otherMatches?.length ? { otherMatches: entry.otherMatches } : {}),
          };
        }
      }
      const findings = pipelineOutput.componentFindings;
      if (!astIndex) {
        // No index was needed, so the report names no file and there is nothing to warn about.
      } else if (!astIndex.treeSitterAvailable) {
        sourceWarning =
          "The tree-sitter parser could not be loaded, so the report gives no file for any component.";
      } else if (findings.length > 0 && !findings.some((f) => f.sourceLocation)) {
        // After the fallback sourceRoot is Metro's root, which the caller never passed.
        const searched =
          sourceRoot === params.project_root ? "project_root" : "Metro's project root";
        const noFile = `No component in the report's table is defined under ${searched} "${sourceRoot}" (${astIndex.indexedFiles} source files on the tool-server host, ${astIndex.index.size} components), so the report gives no file for any of them. They may all be library components. If any of them is from the app, check project_root.`;
        sourceWarning = sourceWarning ? `${sourceWarning} ${noFile}` : noFile;
      } else if (metroRoot && (await unrelatedPaths(metroRoot, sourceRoot))) {
        sourceWarning = `Metro serves this app from "${metroRoot}", but project_root is "${sourceRoot}", so the files in this report may be from another project.`;
      }
    } catch {
      sourceWarning = "Reading the project's source failed, so the report may lack file locations.";
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
      // Paths in the report count from the root the files were read from.
      sessionContext: { ...pipelineOutput.sessionContext, projectRoot: sourceRoot },
      recordingMs: pipelineOutput.recordingMs,
      anyRuntimeCompilerDetected: pipelineOutput.anyRuntimeCompilerDetected,
      reactCommits: pipelineOutput.reactCommits,
      annotations: params.annotations,
      debugDir,
      noHotCommits: pipelineOutput.noHotCommits,
      noReactCommits: totalReactCommits === 0,
      maxCommitMs: pipelineOutput.maxCommitMs,
      renderSummary,
      componentOrigin: createComponentOriginClassifier(sourceIndex),
    });

    const artifacts = requireArtifacts(ctx);
    const result: Record<string, unknown> = {
      ...(sourceWarning ? { warning: sourceWarning } : {}),
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
      const noCommits =
        "No React commit data — the DevTools hook may not be present in this runtime, or the commit-capture script failed to inject (check react-profiler-start output for errors).";
      result["warning"] = sourceWarning ? `${noCommits} ${sourceWarning}` : noCommits;
    }

    return result;
  },
};
