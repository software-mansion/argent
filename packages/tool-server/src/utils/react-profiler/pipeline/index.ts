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
  options?: { debugDumps?: boolean }
): Promise<PipelineOutput> {
  const debugDumps = options?.debugDumps ?? false;
  const debugDir = await getDebugDir();

  const sessionContext = await detectSessionContext(input);

  // Annotate parent-cascade commits with their root cause
  const preprocessed = preprocess(input.commitTree.commits);

  // hotCommitIndices was pre-computed in react-profiler-stop
  const hotCommitIndices = input.sessionMeta.hotCommitIndices ?? [];
  const rawHotCommitSummaries = buildHotCommitSummaries(
    preprocessed,
    hotCommitIndices,
    input.sessionMeta.unattributedByCommit
  );

  // Both sides count ms from the start of profiling, so samples need no offset (#619)
  const cpuSampleIndex = input.flamegraph ? buildCpuSampleIndex(input.flamegraph) : null;
  const hotCommitSummaries = correlateCpuWithCommits(rawHotCommitSummaries, cpuSampleIndex);

  // O(n) over React commits
  const preprocessedCommitTree = { ...input.commitTree, commits: preprocessed };
  const reduceOutput = reduce(
    preprocessedCommitTree,
    sessionContext,
    input.sessionMeta.recordingDurationMs,
    input.sessionMeta.anyCompilerOptimized
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

  // O(k) over the per-component accumulators
  const enrichOutput = enrich(reduceOutput);

  // O(k) false-positive flags
  const tagOutput = tag(enrichOutput);
  if (debugDumps) await writeDump(debugDir, "03_tag.json", tagOutput);

  // O(k log k)
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
    // The all-clear path keeps no commits, so tagOutput.reactCommits is 0
    reactCommits: input.sessionMeta.totalReactCommits ?? tagOutput.reactCommits,
    fiberRenders: tagOutput.fiberRenders,
    totalFirstMounts: tagOutput.totalFirstMounts,
    cpuSampleIndex,
  };
}
