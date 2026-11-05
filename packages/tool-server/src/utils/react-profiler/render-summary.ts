/**
 * Per-component render statistics over ALL commits of a React profiling session.
 *
 * react-profiler-stop persists per-fiber detail only for commits of 16 ms or more
 * and their ±1 neighbours, so on a session made of many cheap commits (a 60 Hz
 * timer re-rendering a list) the saved commits are empty and the report could not
 * see React spending a third of the session rendering. The summary is computed from every commit at stop time and saved as `meta.renderSummary`
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
import type { ComponentOriginResult } from "./component-origin";

export const RENDER_SUMMARY_VERSION = 1;

/**
 * Which components the Most Frequent Re-renders table lists. TENTATIVE, and they
 * decide a listing, never a verdict: the report does not call a session fine or
 * busy from any number here. On six device sessions they list the fixture clock's
 * ClockRow and nothing on Bluesky's fast scroll; they also list SearchScreenShell
 * on stretches of Bluesky typing that had nothing to fix, so a row is not a finding.
 */
/** A row needs at least this many re-renders, and one per second. */
const MIN_FREQUENT_RERENDERS = 10;
/** Summed self time per second of recording below which a row is left out. */
const MIN_FREQUENT_SELF_MS_PER_S = 1;
const MAX_FREQUENT_ROWS = 5;
const MAX_TOP_PROPS = 3;
const MAX_TOP_HOOKS = 3;
const PEAK_WINDOW_MS = 1000;

/** One commit's place in time; the input for the session totals. */
export interface CommitTiming {
  /** ms since profiling started, on the DevTools commit clock. */
  timestamp: number;
  /** DevTools commit duration, ms. */
  durationMs: number;
}

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
   * Sum of the DevTools commit durations. DevTools reports the largest rendered
   * subtree of a commit (its max actualDuration), not the commit's total, so this
   * leaves out updates in other subtrees and the walk through a deep tree, as well
   * as effects and native mounting: 56 ms here against 347 ms of render-phase CPU
   * samples on a Bluesky scroll. It also holds dev-only work and, under Strict
   * Mode, second renders. Treat it as a rough dev-build number.
   */
  totalRenderMs: number;
  /** Most render time in any one second, so idle time cannot hide a burst. */
  peakSecondRenderMs: number;
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

function validDuration(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Largest sum of commit durations inside any window of PEAK_WINDOW_MS. */
function peakWindowMs(commitTimings: readonly CommitTiming[]): number {
  const sorted = commitTimings
    .filter((c) => Number.isFinite(c.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  let peak = 0;
  let inWindow = 0;
  let first = 0;
  for (const commit of sorted) {
    inWindow += validDuration(commit.durationMs);
    while (sorted[first]!.timestamp <= commit.timestamp - PEAK_WINDOW_MS) {
      inWindow -= validDuration(sorted[first]!.durationMs);
      first++;
    }
    if (inWindow > peak) peak = inWindow;
  }
  return peak;
}

/**
 * @param commits every flattened fiber render of the session, not the hot-filtered subset
 * @param commitTimings one entry per flat commit, in any order
 * @param recordingMs session length in ms
 */
export function summarizeRenders(
  commits: readonly DevToolsFiberCommit[],
  commitTimings: readonly CommitTiming[],
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

  let totalRenderMs = 0;
  let maxCommitMs = 0;
  for (const { durationMs } of commitTimings) {
    const ms = validDuration(durationMs);
    totalRenderMs += ms;
    if (ms > maxCommitMs) maxCommitMs = ms;
  }

  return {
    version: RENDER_SUMMARY_VERSION,
    recordingMs: round2(recordingMs),
    totalCommits: commitTimings.length,
    totalRenderMs: round2(totalRenderMs),
    peakSecondRenderMs: round2(peakWindowMs(commitTimings)),
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
    "totalRenderMs",
    "peakSecondRenderMs",
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

/** Fraction (0..1+) of the recording React spent rendering. */
export function renderTimeShare(summary: RenderSummary): number {
  return summary.recordingMs > 0 ? summary.totalRenderMs / summary.recordingMs : 0;
}

/** Fraction (0..1) of the busiest second, or of a recording shorter than a second. */
export function peakRenderShare(summary: RenderSummary): number {
  const windowMs = Math.min(PEAK_WINDOW_MS, summary.recordingMs);
  return windowMs > 0 ? Math.min(summary.peakSecondRenderMs / windowMs, 1) : 0;
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

/** "33%" at or above 10%, one decimal below it ("2.9%"). */
export function formatShare(share: number): string {
  const pct = share * 100;
  if (pct <= 0) return "0%";
  const rounded = Math.round(pct * 10) / 10;
  if (rounded >= 10) return `${Math.round(pct)}%`;
  if (rounded < 0.1) return "<0.1%";
  return `${rounded.toFixed(1)}%`;
}

export function formatMs(ms: number): string {
  return ms >= 10 ? `${Math.round(ms).toLocaleString("en-US")} ms` : `${ms.toFixed(1)} ms`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** "3,366 ms of 10.1 s (33%), peak 40% in 1 s, 468 commits" */
export function formatRenderTime(summary: RenderSummary): string {
  const commits = summary.totalCommits === 1 ? "commit" : "commits";
  const peak =
    summary.totalCommits > 0 ? `, peak ${formatShare(peakRenderShare(summary))} in 1 s` : "";
  return (
    `${formatMs(summary.totalRenderMs)} of ${(summary.recordingMs / 1000).toFixed(1)} s ` +
    `(${formatShare(renderTimeShare(summary))})${peak}, ${formatCount(summary.totalCommits)} ${commits}`
  );
}

export function formatRenderSummaryReason(c: RenderSummaryComponent): string {
  switch (c.reason) {
    case null:
      return "mount only";
    case "props":
      return c.topProps && c.topProps.length > 0 ? `props: ${c.topProps.join(", ")}` : "props";
    case "hooks":
    case "state":
      return c.topHooks && c.topHooks.length > 0
        ? `${c.reason}: ${c.topHooks.join(", ")}`
        : c.reason;
    case "context":
      return "context changed";
    case "parent":
      return "parent re-render";
    case "force_update":
      return "forceUpdate()";
    default:
      return c.reason;
  }
}

export interface FrequentRerenderRow {
  component: RenderSummaryComponent;
  perSecond: number;
  selfMsPerSecond: number;
  origin: ComponentOriginResult;
}

/**
 * App components that re-render at least once per second (and at least 10
 * times), sorted by summed self time per second, at most five. Library
 * components (React Native primitives, list internals, animation wrappers,
 * providers and contexts, dev-only views) are left out by `classify`; see
 * component-origin.ts for how it decides and where it is wrong.
 */
export function selectFrequentRerenders(
  summary: RenderSummary,
  classify: (rawName: string) => ComponentOriginResult,
  limit = MAX_FREQUENT_ROWS
): FrequentRerenderRow[] {
  const seconds = Math.max(summary.recordingMs / 1000, 0.001);
  const minRerenders = Math.max(MIN_FREQUENT_RERENDERS, Math.ceil(seconds));
  const rows: FrequentRerenderRow[] = [];
  for (const component of summary.components) {
    if (component.rerenders < minRerenders) continue;
    const selfMsPerSecond = component.rerenderSelfMs / seconds;
    if (selfMsPerSecond < MIN_FREQUENT_SELF_MS_PER_S) continue;
    const origin = classify(component.name);
    if (origin.origin === "library") continue;
    rows.push({ component, perSecond: component.rerenders / seconds, selfMsPerSecond, origin });
  }
  rows.sort((a, b) => b.selfMsPerSecond - a.selfMsPerSecond);
  return rows.slice(0, limit);
}
