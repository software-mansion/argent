/**
 * Stage 00-hot-commits: HotCommitSummary[] from preprocessed commits, with hot vs
 * margin decided by the hotCommitIndices set react-profiler-stop produced.
 */
import type { DevToolsFiberCommit } from "../types/input";
import type { HotCommitSummary, HotCommitComponentEntry, ReRenderReason } from "../types/output";
import { deriveReason } from "./utils";

const ABSOLUTE_HOT_MS = 50;
const ABSOLUTE_WARM_MS = 16;
const MAX_COMPONENT_ENTRIES = 15; // cap display; totalComponentCount carries the real size

export function buildHotCommitSummaries(
  commits: DevToolsFiberCommit[],
  hotCommitIndices: number[],
  unattributedByCommit?: Array<[number, number, number]>
): HotCommitSummary[] {
  if (commits.length === 0) return [];

  const hotSet = new Set(hotCommitIndices);

  const unattributedMap = new Map<number, { count: number; ms: number }>();
  if (unattributedByCommit) {
    for (const [commitIndex, count, ms] of unattributedByCommit) {
      unattributedMap.set(commitIndex, { count, ms });
    }
  }

  // Commits here include margin (neighbour) commits, not just hot ones
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
    const tier: "hot" | "warm" | null = isMargin
      ? null
      : totalRenderMs > ABSOLUTE_HOT_MS
        ? "hot"
        : totalRenderMs >= ABSOLUTE_WARM_MS
          ? "warm"
          : null; // defensive; floor already applied in react-profiler-stop

    const timestampMs = entries[0]?.timestamp ?? 0;

    const rerenderEntries = entries.filter((e) => {
      const cd = e.changeDescription;
      return !(cd === null || cd.isFirstMount === true);
    });

    // All entries, first mounts included, so navigation mount cost stays visible
    //
    // `selfDuration` sums (exclusive); `actualDuration` does not — same-named
    // instances are routinely nested, so each ancestor's inclusive figure already
    // contains its descendants'. Keep the largest single instance instead.
    const componentMap = new Map<
      string,
      {
        totalSelf: number;
        maxActual: number;
        count: number;
        firstEntry: DevToolsFiberCommit;
        isFirstMount: boolean;
      }
    >();
    for (const e of entries) {
      const cd = e.changeDescription;
      const isFirstMount = cd === null || cd.isFirstMount === true;
      const existing = componentMap.get(e.componentName);
      if (existing) {
        existing.totalSelf += e.selfDuration ?? 0;
        existing.maxActual = Math.max(existing.maxActual, e.actualDuration ?? 0);
        existing.count++;
        if (!isFirstMount) existing.isFirstMount = false;
      } else {
        componentMap.set(e.componentName, {
          totalSelf: e.selfDuration ?? 0,
          maxActual: e.actualDuration ?? 0,
          count: 1,
          firstEntry: e,
          isFirstMount,
        });
      }
    }

    const totalComponentCount = componentMap.size;

    const componentEntries: HotCommitComponentEntry[] = Array.from(componentMap.entries())
      .sort((a, b) => b[1].totalSelf - a[1].totalSelf)
      .slice(0, MAX_COMPONENT_ENTRIES)
      .map(([name, { totalSelf, maxActual, count, firstEntry, isFirstMount }]) => {
        const cd = firstEntry.changeDescription;
        const reason = !isFirstMount && cd ? deriveReason(cd, firstEntry.hookTypes) : undefined;

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
          actualDurationMs: Math.round(maxActual * 100) / 100,
          count,
          ...(isFirstMount && { isFirstMount: true }),
          ...(reason !== undefined && { reason }),
          ...(!isFirstMount &&
            cd?.props &&
            cd.props.length > 0 && { topChangedProps: cd.props.slice(0, 3) }),
          ...(topChangedHookNames && { topChangedHookNames }),
          ...(firstEntry.isCompilerOptimized && { isCompilerOptimized: true }),
        };
        return entry;
      });

    const firstMountMs = Array.from(componentMap.values())
      .filter((v) => v.isFirstMount)
      .reduce((sum, v) => sum + v.totalSelf, 0);
    const isInitialRender = firstMountMs > totalRenderMs * 0.5;

    let rootCauseComponent: string | undefined;
    let rootCauseReason: ReRenderReason | undefined;
    let rootCauseChangedProps: string[] | undefined;
    let rootCauseChangedHookNames: string[] | undefined;

    if (!isInitialRender) {
      // componentEntries is self-duration DESC, so the first match is the heaviest
      const rootCauseEntry = componentEntries.find(
        (e) => !e.isFirstMount && e.reason && e.reason !== "parent"
      );
      if (rootCauseEntry) {
        rootCauseComponent = rootCauseEntry.name;
        rootCauseReason = rootCauseEntry.reason;
        rootCauseChangedProps = rootCauseEntry.topChangedProps;
        rootCauseChangedHookNames = rootCauseEntry.topChangedHookNames;
      } else {
        // Nothing but parent cascades — fall back to the preprocess annotation
        const withRootCause = rerenderEntries.find((e) => e.rootCauseParent && e.rootCauseReason);
        if (withRootCause) {
          rootCauseComponent = withRootCause.rootCauseParent;
          rootCauseReason = withRootCause.rootCauseReason;
          if (withRootCause.rootCauseProps && withRootCause.rootCauseProps.length > 0) {
            rootCauseChangedProps = withRootCause.rootCauseProps.slice(0, 3);
          }
          // rootCauseHooks are indices into the root cause's full rootCauseHookTypes
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
              .map((idx) => `hook[${idx}]`);
          }
        }
      }
    }

    const unattributed = unattributedMap.get(commitIndex);

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
      ...(rootCauseChangedHookNames &&
        rootCauseChangedHookNames.length > 0 && { rootCauseChangedHookNames }),
      components: componentEntries,
      totalComponentCount,
      ...(unattributed &&
        unattributed.count > 0 && {
          unattributedMs: unattributed.ms,
          unattributedFiberCount: unattributed.count,
        }),
    });
  }

  return summaries.sort((a, b) => a.commitIndex - b.commitIndex);
}
