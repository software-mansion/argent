/**
 * Stage 00-hot-commits: Build HotCommitSummary[] from preprocessed commits
 * and hot commit indices determined by profiler-stop.
 *
 * Groups commits by commitIndex, marks hot vs margin using hotCommitIndices set,
 * identifies root cause component per commit using preprocess annotations,
 * groups same-named components (e.g. list items) for compact display.
 */
import type { DevToolsFiberCommit } from '../types/input.js';
import type { HotCommitSummary, HotCommitComponentEntry, ReRenderReason } from '../types/output.js';
import { deriveReason } from './utils';

const ABSOLUTE_HOT_MS = 50;
const ABSOLUTE_WARM_MS = 16;
const MAX_COMPONENT_ENTRIES = 15;  // cap cascade display; store total count separately

export function buildHotCommitSummaries(
  commits: DevToolsFiberCommit[],
  hotCommitIndices: number[],
): HotCommitSummary[] {
  if (commits.length === 0) return [];

  const hotSet = new Set(hotCommitIndices);

  // Group commits by commitIndex (includes both hot and margin entries)
  const byCommit = new Map<number, DevToolsFiberCommit[]>();
  for (const commit of commits) {
    if (!commit.didRender) continue;
    let group = byCommit.get(commit.commitIndex);
    if (!group) {
      group = [];
      byCommit.set(commit.commitIndex, group);
    }
    group.push(commit);
  }

  const summaries: HotCommitSummary[] = [];

  for (const [commitIndex, entries] of byCommit) {
    const totalRenderMs = entries[0]?.commitDuration ?? 0;

    const isMargin = !hotSet.has(commitIndex);
    const tier: 'hot' | 'warm' | null = isMargin
      ? null
      : totalRenderMs > ABSOLUTE_HOT_MS
        ? 'hot'
        : totalRenderMs >= ABSOLUTE_WARM_MS
          ? 'warm'
          : null;  // defensive; floor already applied in profiler-stop

    // Get commit timestamp from first entry
    const timestampMs = entries[0]?.timestamp ?? 0;

    // Filter out first-mounts for the cascade display
    const rerenderEntries = entries.filter(e => {
      const cd = e.changeDescription;
      return !(cd === null || cd.isFirstMount === true);
    });

    // Group by component name within this commit, accumulate self-duration
    // Include ALL entries (re-renders + first mounts) so navigation mount cost is visible
    const componentMap = new Map<string, {
      totalSelf: number;
      count: number;
      firstEntry: DevToolsFiberCommit;
      isFirstMount: boolean;
    }>();
    for (const e of entries) {
      const cd = e.changeDescription;
      const isFirstMount = cd === null || cd.isFirstMount === true;
      const existing = componentMap.get(e.componentName);
      if (existing) {
        existing.totalSelf += e.selfDuration ?? 0;
        existing.count++;
        // If any instance is a re-render, mark as not first-mount
        if (!isFirstMount) existing.isFirstMount = false;
      } else {
        componentMap.set(e.componentName, {
          totalSelf: e.selfDuration ?? 0,
          count: 1,
          firstEntry: e,
          isFirstMount,
        });
      }
    }

    const totalComponentCount = componentMap.size;

    // Build component entries sorted by total self-duration DESC, cap at MAX_COMPONENT_ENTRIES
    const componentEntries: HotCommitComponentEntry[] = Array.from(componentMap.entries())
      .sort((a, b) => b[1].totalSelf - a[1].totalSelf)
      .slice(0, MAX_COMPONENT_ENTRIES)
      .map(([name, { totalSelf, count, firstEntry, isFirstMount }]) => {
        const cd = firstEntry.changeDescription;
        const reason = (!isFirstMount && cd) ? deriveReason(cd, firstEntry.hookTypes) : undefined;

        // Build changed hook names for re-render entries only
        let topChangedHookNames: string[] | undefined;
        if (!isFirstMount && cd?.hooks && cd.hooks.length > 0 && firstEntry.hookTypes) {
          const seen = new Set<string>();
          topChangedHookNames = [];
          for (const idx of cd.hooks.slice(0, 3)) {
            const typeName = firstEntry.hookTypes[idx] ?? `hook[${idx}]`;
            if (!seen.has(typeName)) {
              seen.add(typeName);
              topChangedHookNames.push(typeName);
            }
          }
          if (topChangedHookNames.length === 0) topChangedHookNames = undefined;
        }

        const entry: HotCommitComponentEntry = {
          name,
          selfDurationMs: Math.round(totalSelf * 100) / 100,
          count,
          ...(isFirstMount && { isFirstMount: true }),
          ...(reason !== undefined && { reason }),
          ...(!isFirstMount && cd?.props && cd.props.length > 0 && { topChangedProps: cd.props.slice(0, 3) }),
          ...(topChangedHookNames && { topChangedHookNames }),
          ...(firstEntry.isCompilerOptimized && { isCompilerOptimized: true }),
        };
        return entry;
      });

    // Determine if this commit is dominated by first-mount (initial render) activity
    const firstMountMs = Array.from(componentMap.values())
      .filter(v => v.isFirstMount)
      .reduce((sum, v) => sum + v.totalSelf, 0);
    const isInitialRender = firstMountMs > totalRenderMs * 0.5;

    // Find root cause: the non-parent, non-mount component with highest self-duration
    let rootCauseComponent: string | undefined;
    let rootCauseReason: ReRenderReason | undefined;
    let rootCauseChangedProps: string[] | undefined;
    let rootCauseChangedHookNames: string[] | undefined;

    if (!isInitialRender) {
      const rootCauseEntry = componentEntries.find(e => !e.isFirstMount && e.reason && e.reason !== 'parent');
      if (rootCauseEntry) {
        rootCauseComponent = rootCauseEntry.name;
        rootCauseReason = rootCauseEntry.reason;
        rootCauseChangedProps = rootCauseEntry.topChangedProps;
        rootCauseChangedHookNames = rootCauseEntry.topChangedHookNames;
      } else {
        // All parent cascades — check rootCauseParent annotation from preprocess
        const withRootCause = rerenderEntries.find(e => e.rootCauseParent && e.rootCauseReason);
        if (withRootCause) {
          rootCauseComponent = withRootCause.rootCauseParent;
          rootCauseReason = withRootCause.rootCauseReason;
          if (withRootCause.rootCauseProps && withRootCause.rootCauseProps.length > 0) {
            rootCauseChangedProps = withRootCause.rootCauseProps.slice(0, 3);
          }
          // rootCauseHookTypes are the full hookTypes of the root cause component;
          // rootCauseHooks are the changed indices — map them
          if (withRootCause.rootCauseHooks && withRootCause.rootCauseHookTypes) {
            const hookNames: string[] = [];
            const seen = new Set<string>();
            for (const idx of withRootCause.rootCauseHooks.slice(0, 3)) {
              const typeName = withRootCause.rootCauseHookTypes[idx] ?? `hook[${idx}]`;
              if (!seen.has(typeName)) {
                seen.add(typeName);
                hookNames.push(typeName);
              }
            }
            if (hookNames.length > 0) rootCauseChangedHookNames = hookNames;
          } else if (withRootCause.rootCauseHooks && withRootCause.rootCauseHooks.length > 0) {
            rootCauseChangedHookNames = withRootCause.rootCauseHooks
              .slice(0, 3)
              .map(idx => `hook[${idx}]`);
          }
        }
      }
    }

    summaries.push({
      commitIndex,
      timestampMs,
      totalRenderMs: Math.round(totalRenderMs * 100) / 100,
      isMargin,
      tier,
      ...(isInitialRender && { isInitialRender: true }),
      ...(rootCauseComponent && { rootCauseComponent }),
      ...(rootCauseReason && { rootCauseReason }),
      ...(rootCauseChangedProps && rootCauseChangedProps.length > 0 && { rootCauseChangedProps }),
      ...(rootCauseChangedHookNames && rootCauseChangedHookNames.length > 0 && { rootCauseChangedHookNames }),
      components: componentEntries,
      totalComponentCount,
    });
  }

  // Sort by commitIndex ascending
  return summaries.sort((a, b) => a.commitIndex - b.commitIndex);
}
