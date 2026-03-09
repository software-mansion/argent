/**
 * Stage 2: Enrich
 *
 * Derives statistics from Welford accumulators:
 *   mean, totalRenderMs, normalizedRenderCount
 *
 * Also computes:
 *   isCompilerOptimized — true if >50% of renders showed useMemoCache
 *   parentTrigger       — root cause component + reason for parent-cascade cases
 */
import type { ReduceOutput, EnrichOutput, EnrichedComponent, RootCauseVote } from '../types/pipeline.js';
import type { ReRenderReason } from '../types/output.js';

function topN<K>(freq: Map<K, number>, n: number): K[] {
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

function dominantReason(histogram: Record<ReRenderReason, number>): ReRenderReason {
  let best: ReRenderReason = 'unknown';
  let bestCount = -1;
  for (const [reason, count] of Object.entries(histogram) as [ReRenderReason, number][]) {
    if (count > bestCount) {
      bestCount = count;
      best = reason;
    }
  }
  return best;
}

function topParent(parentFreq: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const [name, count] of parentFreq) {
    if (count > bestCount) {
      bestCount = count;
      best = name;
    }
  }
  return best;
}

function bestRootCause(
  votes: Map<string, RootCauseVote>,
  hookTypeNames: string[] | undefined,
): EnrichedComponent['parentTrigger'] {
  if (votes.size === 0) return undefined;

  let bestParent = '';
  let bestData: RootCauseVote | undefined;
  for (const [parent, data] of votes) {
    if (!bestData || data.count > bestData.count) {
      bestParent = parent;
      bestData = data;
    }
  }

  if (!bestData) return undefined;

  // Resolve hook names from the root cause component's hookTypes
  const ht = bestData.hookTypes ?? hookTypeNames;
  const changedHookNames = ht
    ? bestData.changedHooks.map((idx) => ht[idx] ?? `hook[${idx}]`)
    : [];

  const result: NonNullable<EnrichedComponent['parentTrigger']> = {
    component: bestParent,
    reason: bestData.reason,
    changedProps: bestData.changedProps,
    changedHooks: bestData.changedHooks,
    changedHookNames,
  };
  if (bestData.chain.length > 1) result.parentChain = bestData.chain;
  return result;
}

export function enrich(input: ReduceOutput): EnrichOutput {
  const { sessionContext } = input;
  const strictMode = sessionContext.strictModeEnabled;

  const components = new Map<string, EnrichedComponent>();

  for (const [name, acc] of input.components) {
    const n = acc.n;
    if (n === 0) continue;

    const mean = acc.sum / n;
    const totalRenderMs = n * mean;
    const normalizedRenderCount = strictMode ? Math.ceil(n / 2) : n;

    const dr = dominantReason(acc.reasonHistogram);
    const dp = dr === 'parent' ? topParent(acc.parentFreq) : undefined;
    const isCompilerOptimized = acc.compilerOptimizedCount > n / 2;
    const parentTrigger = dr === 'parent'
      ? bestRootCause(acc.rootCauseVotes, acc.hookTypeNames)
      : undefined;

    const enriched: EnrichedComponent = {
      name,
      n,
      normalizedRenderCount,
      mean,
      min: acc.min === Infinity ? 0 : acc.min,
      max: acc.max === -Infinity ? 0 : acc.max,
      totalRenderMs,
      dominantReason: dr,
      topChangedProps: topN(acc.propFreq, 3),
      topChangedHooks: topN(acc.hookFreq, 3),
      isCompilerOptimized,
      firstCommitTs: acc.firstCommitTs,
      lastCommitTs: acc.lastCommitTs,
    };
    if (dp !== undefined) enriched.dominantParent = dp;
    if (acc.hookTypeNames !== undefined) enriched.hookTypeNames = acc.hookTypeNames;
    if (parentTrigger !== undefined) enriched.parentTrigger = parentTrigger;

    components.set(name, enriched);
  }

  return {
    components,
    sessionContext,
    reactCommits: input.reactCommits,
    fiberRenders: input.fiberRenders,
    anyRuntimeCompilerDetected: input.anyRuntimeCompilerDetected,
    totalFirstMounts: input.totalFirstMounts,
    firstMountOnlyComponents: input.firstMountOnlyComponents,
    recordingMs: input.recordingMs,
  };
}
