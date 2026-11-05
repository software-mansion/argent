/**
 * Per-component render statistics over ALL commits of a React profiling session.
 *
 * react-profiler-stop persists per-fiber detail only for commits of 16 ms or more
 * and their ±1 neighbours, so on a session made of many cheap commits (a 60 Hz
 * timer re-rendering a list) the saved commits are empty and the report used to
 * say "all clear" while React spent a third of the session rendering. The summary
 * is computed from every commit at stop time and saved as `meta.renderSummary`
 * next to the kept commits, which stay exactly as before.
 *
 * Measured on six device sessions (Bluesky and an Expo fixture): 0.1-5 ms to
 * compute and 1-78 KB on disk, while every commit already crosses CDP at stop.
 * Sessions saved before this field existed simply lack it; every reader goes
 * through `parseRenderSummary` and treats a missing or unreadable value as absent.
 */
import type { DevToolsFiberCommit } from "./types/input";
import type { ReRenderReason } from "./types/output";
import { deriveReason } from "./pipeline/utils";

export const RENDER_SUMMARY_VERSION = 1;

/**
 * Share of the recording React spent in commits at which a session with no
 * commit of 16 ms or more stops being reported as all clear.
 *
 * TENTATIVE. Picked from six device sessions only: fixture 60 Hz clock 33.4%,
 * fixture 500-row list 23.9%, Bluesky tab switches 12.9%, fixture janky renders
 * 12.3%, Bluesky typing 2.9%, Bluesky fast scroll 0.8%. 10% separates the clock
 * (a real problem with no slow commit) from typing and scrolling (nothing worth
 * fixing), but six sessions cannot settle the number. Revisit it with more apps,
 * release builds and Android.
 */
export const COMMIT_TIME_SHARE_FLOOR = 0.1;

const MAX_TOP_PROPS = 3;
const MAX_TOP_HOOKS = 3;

export interface RenderSummaryComponent {
  /** Raw React DevTools display name, the key the saved commits use. */
  name: string;
  /** Renders that were not first mounts. */
  rerenders: number;
  /** Distinct commits with at least one re-render of this component. */
  rerenderCommits: number;
  /** Summed self (exclusive) time of those re-renders, ms. */
  rerenderSelfMs: number;
  maxRerenderSelfMs: number;
  mounts: number;
  mountSelfMs: number;
  /** Dominant re-render reason; null when the component only mounted. */
  reason: ReRenderReason | null;
  topProps?: string[];
  topHooks?: string[];
}

export interface RenderSummary {
  version: typeof RENDER_SUMMARY_VERSION;
  /** CPU profile duration, the session length the report header prints. */
  recordingMs: number;
  /** Every commit the DevTools backend recorded, across all roots. */
  totalCommits: number;
  /**
   * Sum of the DevTools commit durations. That is render-phase time; it leaves
   * out layout and passive effects and native mounting, so it is a lower bound
   * on the main-thread time React costs.
   */
  totalCommitMs: number;
  maxCommitMs: number;
  /** Attributed fiber renders; fibers whose name was lost at stop are not counted. */
  fiberRenders: number;
  rerenders: number;
  mounts: number;
  /** Sorted by rerenderSelfMs, then rerenders, descending. */
  components: RenderSummaryComponent[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function topKeys<K>(freq: Map<K, number>, n: number): K[] {
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

/**
 * @param commits every flattened fiber render of the session, not the hot-filtered subset
 * @param commitDurations one DevTools commit duration per flat commit index
 * @param recordingMs session length in ms
 */
export function summarizeRenders(
  commits: readonly DevToolsFiberCommit[],
  commitDurations: readonly number[],
  recordingMs: number
): RenderSummary {
  interface Acc {
    rerenders: number;
    rerenderSelfMs: number;
    maxRerenderSelfMs: number;
    mounts: number;
    mountSelfMs: number;
    lastRerenderCommit: number;
    rerenderCommits: number;
    reasons: Map<ReRenderReason, number>;
    props: Map<string, number>;
    hooks: Map<string, number>;
  }
  const byName = new Map<string, Acc>();
  let fiberRenders = 0;
  let rerenders = 0;
  let mounts = 0;

  for (const c of commits) {
    if (!c.didRender) continue;
    fiberRenders++;
    let acc = byName.get(c.componentName);
    if (!acc) {
      acc = {
        rerenders: 0,
        rerenderSelfMs: 0,
        maxRerenderSelfMs: 0,
        mounts: 0,
        mountSelfMs: 0,
        lastRerenderCommit: -1,
        rerenderCommits: 0,
        reasons: new Map(),
        props: new Map(),
        hooks: new Map(),
      };
      byName.set(c.componentName, acc);
    }
    const cd = c.changeDescription;
    // Same first-mount rule as the analyze pipeline's reduce stage.
    if (cd === null || cd.isFirstMount === true) {
      mounts++;
      acc.mounts++;
      acc.mountSelfMs += c.selfDuration;
      continue;
    }
    rerenders++;
    acc.rerenders++;
    acc.rerenderSelfMs += c.selfDuration;
    if (c.selfDuration > acc.maxRerenderSelfMs) acc.maxRerenderSelfMs = c.selfDuration;
    // Flattened fibers arrive grouped by commit, so a change of index is a new commit.
    if (c.commitIndex !== acc.lastRerenderCommit) {
      acc.rerenderCommits++;
      acc.lastRerenderCommit = c.commitIndex;
    }
    const reason = deriveReason(cd, c.hookTypes ?? null);
    acc.reasons.set(reason, (acc.reasons.get(reason) ?? 0) + 1);
    for (const p of cd.props ?? []) acc.props.set(p, (acc.props.get(p) ?? 0) + 1);
    if (cd.hooks && c.hookTypes) {
      for (const idx of cd.hooks) {
        const hook = c.hookTypes[idx] ?? `hook[${idx}]`;
        acc.hooks.set(hook, (acc.hooks.get(hook) ?? 0) + 1);
      }
    }
  }

  const components: RenderSummaryComponent[] = [];
  for (const [name, acc] of byName) {
    const reason = acc.rerenders > 0 ? (topKeys(acc.reasons, 1)[0] ?? null) : null;
    const row: RenderSummaryComponent = {
      name,
      rerenders: acc.rerenders,
      rerenderCommits: acc.rerenderCommits,
      rerenderSelfMs: round2(acc.rerenderSelfMs),
      maxRerenderSelfMs: round2(acc.maxRerenderSelfMs),
      mounts: acc.mounts,
      mountSelfMs: round2(acc.mountSelfMs),
      reason,
    };
    const topProps = topKeys(acc.props, MAX_TOP_PROPS);
    if (topProps.length > 0) row.topProps = topProps;
    const topHooks = topKeys(acc.hooks, MAX_TOP_HOOKS);
    if (topHooks.length > 0) row.topHooks = topHooks;
    components.push(row);
  }
  components.sort(
    (a, b) =>
      b.rerenderSelfMs - a.rerenderSelfMs ||
      b.rerenders - a.rerenders ||
      b.mountSelfMs - a.mountSelfMs ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );

  let totalCommitMs = 0;
  let maxCommitMs = 0;
  for (const d of commitDurations) {
    const ms = Number.isFinite(d) && d > 0 ? d : 0;
    totalCommitMs += ms;
    if (ms > maxCommitMs) maxCommitMs = ms;
  }

  return {
    version: RENDER_SUMMARY_VERSION,
    recordingMs: round2(recordingMs),
    totalCommits: commitDurations.length,
    totalCommitMs: round2(totalCommitMs),
    maxCommitMs: round2(maxCommitMs),
    fiberRenders,
    rerenders,
    mounts,
    components,
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Read `meta.renderSummary` from a saved session. Returns null for sessions saved
 * before the field existed, a future version, or a value that does not have the
 * shape, so a reader never throws on an old or damaged file.
 */
export function parseRenderSummary(raw: unknown): RenderSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.version !== RENDER_SUMMARY_VERSION) return null;
  for (const key of [
    "recordingMs",
    "totalCommits",
    "totalCommitMs",
    "maxCommitMs",
    "fiberRenders",
    "rerenders",
    "mounts",
  ]) {
    if (!isFiniteNumber(s[key])) return null;
  }
  if (!Array.isArray(s.components)) return null;
  for (const c of s.components) {
    if (!c || typeof c !== "object") return null;
    const row = c as Record<string, unknown>;
    if (typeof row.name !== "string") return null;
    for (const key of [
      "rerenders",
      "rerenderCommits",
      "rerenderSelfMs",
      "maxRerenderSelfMs",
      "mounts",
      "mountSelfMs",
    ]) {
      if (!isFiniteNumber(row[key])) return null;
    }
  }
  return raw as RenderSummary;
}

/** Fraction (0..1+) of the recording React spent in commits. */
export function commitTimeShare(summary: RenderSummary): number {
  return summary.recordingMs > 0 ? summary.totalCommitMs / summary.recordingMs : 0;
}

/** True when the session is busy enough that "all clear" would be wrong. */
export function isCommitTimeAboveFloor(summary: RenderSummary): boolean {
  return commitTimeShare(summary) >= COMMIT_TIME_SHARE_FLOOR;
}

/** A commit at or over this missed a 60 Hz frame. */
export const SLOW_COMMIT_MS = 16;

/**
 * For a session with no hot commit: did a commit reach the floor anyway? Hot
 * commits are picked from named fibers, so a commit whose fibers all lost their
 * display names (unmounted before stop, or a DevTools backend with no name
 * accessor) is never kept, while its duration still counts in this summary.
 */
export function hasUnnamedSlowCommit(summary: RenderSummary): boolean {
  return summary.maxCommitMs >= SLOW_COMMIT_MS;
}

/**
 * "33%" at or above 10%, one decimal below it ("2.9%"). A share just under 10%
 * prints as "9.9%", never "10.0%", so the line cannot contradict the gate.
 */
export function formatShare(share: number): string {
  const pct = share * 100;
  if (pct <= 0) return "0%";
  if (pct >= 10) return `${Math.round(pct)}%`;
  const rounded = Math.round(pct * 10) / 10;
  if (rounded < 0.1) return "<0.1%";
  return `${Math.min(rounded, 9.9).toFixed(1)}%`;
}

export function formatMs(ms: number): string {
  return ms >= 10 ? `${Math.round(ms).toLocaleString("en-US")} ms` : `${ms.toFixed(1)} ms`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** "3,366 ms of 10.1 s (33%), 468 commits" */
export function formatCommitTime(summary: RenderSummary): string {
  const commits = summary.totalCommits === 1 ? "commit" : "commits";
  return (
    `${formatMs(summary.totalCommitMs)} of ${(summary.recordingMs / 1000).toFixed(1)} s ` +
    `(${formatShare(commitTimeShare(summary))}), ${formatCount(summary.totalCommits)} ${commits}`
  );
}
