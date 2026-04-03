import type { RawProfilingInput } from "../types/input";
import type { PipelineOutput } from "../types/pipeline";
import { getDebugDir, writeDump } from "../debug/dump";
import { detectSessionContext } from "./session-context";
import { preprocess } from "./00-preprocess";
import { buildHotCommitSummaries } from "./00-hot-commits";
import { buildCpuSampleIndex, correlateCpuWithCommits } from "./00-cpu-correlate";
import { reduce } from "./01-reduce";
import { enrich } from "./02-enrich";
import { tag } from "./03-tag";
import { rank } from "./04-rank";

export async function runPipeline(
  input: RawProfilingInput,
  options?: { debugDumps?: boolean },
): Promise<PipelineOutput> {
  const debugDumps = options?.debugDumps ?? false;
  const debugDir = await getDebugDir();

  const sessionContext = await detectSessionContext(input);

  // Stage 0: Preprocess — annotate parent-cascade commits with root cause
  const preprocessed = preprocess(input.commitTree.commits);

  // Stage 00-hot-commits: Build HotCommitSummary[] from preprocessed commits
  // Uses hotCommitIndices from sessionMeta (pre-computed in react-profiler-stop)
  const hotCommitIndices = input.sessionMeta.hotCommitIndices ?? [];
  const rawHotCommitSummaries = buildHotCommitSummaries(
    preprocessed,
    hotCommitIndices,
  );

  // Stage 00-cpu-correlate: Map Hermes CPU samples to hot commit time windows
  const firstCommitTs = preprocessed.length > 0 ? preprocessed[0]!.timestamp : null;
  const cpuSampleIndex = input.flamegraph
    ? buildCpuSampleIndex(input.flamegraph, firstCommitTs)
    : null;
  const hotCommitSummaries = correlateCpuWithCommits(
    rawHotCommitSummaries,
    cpuSampleIndex,
  );

  // Stage 1: Reduce — O(n) over React commits
  const preprocessedCommitTree = { ...input.commitTree, commits: preprocessed };
  const reduceOutput = reduce(
    preprocessedCommitTree,
    sessionContext,
    input.sessionMeta.recordingDurationMs,
    input.sessionMeta.anyCompilerOptimized,
  );

  // Override static compiler detection with runtime evidence
  if (
    reduceOutput.anyRuntimeCompilerDetected &&
    !reduceOutput.sessionContext.reactCompilerEnabled
  ) {
    reduceOutput.sessionContext = {
      ...reduceOutput.sessionContext,
      reactCompilerEnabled: true,
    };
  }

  if (debugDumps) await writeDump(debugDir, "01_reduce.json", reduceOutput);

  // Stage 2: Enrich — O(k) derive stats from Welford accumulators
  const enrichOutput = enrich(reduceOutput);

  // Stage 3: Tag — O(k) false-positive context flags
  const tagOutput = tag(enrichOutput);
  if (debugDumps) await writeDump(debugDir, "03_tag.json", tagOutput);

  // Stage 4: Filter, rank, serialize — O(k log k)
  const componentFindings = rank(tagOutput);
  if (debugDumps) await writeDump(debugDir, "04_component_findings.json", componentFindings);

  return {
    hotCommitSummaries,
    componentFindings,
    sessionContext: tagOutput.sessionContext,
    recordingMs: tagOutput.recordingMs,
    allClear: input.sessionMeta.allClear ?? false,
    maxCommitMs: input.sessionMeta.maxCommitMs,
    anyRuntimeCompilerDetected: tagOutput.anyRuntimeCompilerDetected,
    // Use stored total from react-profiler-stop when available (all-clear path has no commits to count)
    reactCommits: input.sessionMeta.totalReactCommits ?? tagOutput.reactCommits,
    fiberRenders: tagOutput.fiberRenders,
    totalFirstMounts: tagOutput.totalFirstMounts,
    cpuSampleIndex,
  };
}
