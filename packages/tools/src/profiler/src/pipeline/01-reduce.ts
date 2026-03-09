/**
 * Stage 1: Reduce
 *
 * React: one pass over commits[] to group by component using Welford accumulators.
 *        First-mount commits are stripped before statistics.
 *
 * anyRuntimeCompilerDetected is seeded from sessionMeta.anyCompilerOptimized (scanned
 * in profiler-stop before hot-commit filtering) so React Compiler detection works even
 * when compiler-optimized components render fast and appear only in cold commits.
 *
 * totalCommits fix: counts unique commitIndex values (actual React reconciler
 * batches), not individual fiber render entries. The old count is exposed as
 * fiberRenders for reference.
 */
import type { DevToolsCommitTree } from '../types/input.js';
import type {
  ReduceOutput,
  ComponentAccumulator,
  SessionContext,
  RootCauseVote,
} from '../types/pipeline.js';
import { deriveReason } from './utils';

const EMPTY_REASON_HISTOGRAM = () => ({
  parent: 0,
  props: 0,
  hooks: 0,
  context: 0,
  state: 0,
  force_update: 0,
  unknown: 0,
});

export function reduce(
  commitTree: DevToolsCommitTree,
  sessionContext: SessionContext,
  recordingMs: number,
  sessionAnyCompilerOptimized?: boolean,
): ReduceOutput {
  // -------------------------------------------------------------------------
  // React: group commits by component, accumulate Welford stats
  // -------------------------------------------------------------------------
  const components = new Map<string, ComponentAccumulator>();
  const componentHadRerender = new Set<string>();
  const componentFirstMountOnly = new Set<string>();
  const seenCommitIndices = new Set<number>();
  let fiberRenders = 0;   // total fiber render entries
  let totalFirstMounts = 0;
  // Seed from pre-profiling-stop scan (captures compiler-optimized components in cold commits)
  let anyRuntimeCompilerDetected = sessionAnyCompilerOptimized === true;

  for (const commit of commitTree.commits) {
    if (!commit.didRender) continue;
    fiberRenders++;
    seenCommitIndices.add(commit.commitIndex);

    if (commit.isCompilerOptimized) anyRuntimeCompilerDetected = true;

    const cd = commit.changeDescription;
    const isFirstMount = cd === null || cd.isFirstMount === true;

    if (isFirstMount) {
      totalFirstMounts++;
      if (!componentHadRerender.has(commit.componentName)) {
        componentFirstMountOnly.add(commit.componentName);
      }
      continue;
    }

    componentHadRerender.add(commit.componentName);
    componentFirstMountOnly.delete(commit.componentName);

    const reason = deriveReason(cd, commit.hookTypes);
    const duration = commit.selfDuration;
    const ts = commit.timestamp;

    let acc = components.get(commit.componentName);
    if (acc === undefined) {
      acc = {
        name: commit.componentName,
        n: 0,
        sum: 0,
        sumSq: 0,
        min: Infinity,
        max: -Infinity,
        reasonHistogram: EMPTY_REASON_HISTOGRAM(),
        propFreq: new Map(),
        hookFreq: new Map(),
        parentFreq: new Map(),
        compilerOptimizedCount: 0,
        rootCauseVotes: new Map(),
        firstCommitTs: ts,
        lastCommitTs: ts,
      };
      components.set(commit.componentName, acc);
    }

    acc.n++;
    acc.sum += duration;
    acc.sumSq += duration * duration;
    if (duration < acc.min) acc.min = duration;
    if (duration > acc.max) acc.max = duration;
    acc.reasonHistogram[reason]++;
    if (ts < acc.firstCommitTs) acc.firstCommitTs = ts;
    if (ts > acc.lastCommitTs) acc.lastCommitTs = ts;

    if (commit.isCompilerOptimized) acc.compilerOptimizedCount++;

    if (cd.props !== null && cd.props.length > 0) {
      for (const prop of cd.props) {
        acc.propFreq.set(prop, (acc.propFreq.get(prop) ?? 0) + 1);
      }
    }
    if (cd.hooks !== null && cd.hooks.length > 0) {
      for (const hookIdx of cd.hooks) {
        acc.hookFreq.set(hookIdx, (acc.hookFreq.get(hookIdx) ?? 0) + 1);
      }
    }

    // hookTypeNames: first non-null value wins
    if (!acc.hookTypeNames && commit.hookTypes != null && commit.hookTypes.length > 0) {
      acc.hookTypeNames = commit.hookTypes;
    }

    if (commit.parentName) {
      acc.parentFreq.set(commit.parentName, (acc.parentFreq.get(commit.parentName) ?? 0) + 1);
    }

    // Root cause votes (annotated by Stage 0 preprocess)
    if (commit.rootCauseParent && commit.rootCauseReason) {
      const existing = acc.rootCauseVotes.get(commit.rootCauseParent);
      if (existing) {
        existing.count++;
      } else {
        const vote: RootCauseVote = {
          count: 1,
          reason: commit.rootCauseReason,
          changedProps: commit.rootCauseProps ?? [],
          changedHooks: commit.rootCauseHooks ?? [],
          hookTypes: commit.rootCauseHookTypes ?? null,
          chain: commit.rootCauseChain ?? [],
        };
        acc.rootCauseVotes.set(commit.rootCauseParent, vote);
      }
    }
  }

  const firstMountOnlyComponents = Array.from(componentFirstMountOnly);

  return {
    components,
    reactCommits: seenCommitIndices.size,
    fiberRenders,
    anyRuntimeCompilerDetected,
    totalFirstMounts,
    firstMountOnlyComponents,
    sessionContext,
    recordingMs,
  };
}
