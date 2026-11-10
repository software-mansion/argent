/**
 * Per-component render statistics over ALL commits of a React profiling session.
 *
 * react-profiler-stop persists per-fiber detail only for commits of 16 ms or more
 * and their ±1 neighbours, so on a session made of many cheap commits (a 60 Hz
 * timer re-rendering a list) the saved commits are empty and the report could not
 * see React spending a third of the session rendering. The summary is computed
 * from every commit at stop time and saved as `meta.renderSummary` next to the
 * kept commits.
 *
 * Measured on six device sessions (Bluesky and an Expo fixture): 0.1-5 ms to
 * compute and 1-78 KB on disk, while every commit already crosses CDP at stop.
 * Sessions saved before this field existed simply lack it; every reader goes
 * through `parseRenderSummary` and treats a missing or unreadable value as absent.
 */
import type { DevToolsFiberCommit } from "./types/input";
import type { ReRenderReason } from "./types/output";
import { deriveReason, dominantReason, emptyReasonHistogram } from "./pipeline/utils";
import type { ComponentOriginResult } from "./component-origin";
import {
  describeResolution,
  renderComponentNameMiss,
  resolveComponentName,
  type ComponentNameResolution,
} from "./component-names";

export const RENDER_SUMMARY_VERSION = 1;

/**
 * Which components the Most Frequent Re-renders table lists. TENTATIVE, and they
 * decide a listing, never a verdict: the report does not call a session fine or
 * busy from any number here. On six device sessions they list the fixture clock's
 * ClockRow and nothing on Bluesky's fast scroll; they also list SearchScreenShell
 * on stretches of Bluesky typing that had nothing to fix, so a row is not a finding.
 */
/** A row needs re-renders in at least this many commits: 100 rows in one commit is one event. */
const MIN_FREQUENT_RERENDER_COMMITS = 10;
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
  /** Summed self time of the fibers that rendered in this commit, named or not, ms. */
  selfMs?: number;
}

export interface RenderSummaryComponent {
  /** Raw React DevTools display name, the key the saved commits use. */
  name: string;
  /** Renders with change data that were not first mounts. */
  rerenders: number;
  /** Renders with no change data: DevTools records none for context fibers. */
  untrackedRenders: number;
  /** Distinct commits with at least one re-render of this component. */
  rerenderCommits: number;
  /** Summed self (exclusive) time of those re-renders, ms. */
  rerenderSelfMs: number;
  maxRerenderSelfMs: number;
  mounts: number;
  mountSelfMs: number;
  /** Dominant re-render reason; null with no re-render. */
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
   * Render time over all commits: for each one, the larger of its DevTools
   * duration and the summed self time of its fibers. DevTools reports the largest
   * rendered subtree (its max actualDuration), so updates in separate subtrees,
   * such as store subscribers, show only in the self times, which in turn miss the
   * fibers DevTools filters out. The walk through a deep tree, effects and native
   * mounting are in neither: a Bluesky scroll measured 56 ms by duration against
   * 347 ms of render-phase CPU samples. It also holds dev-only work and, under
   * Strict Mode, second renders. Treat it as a rough dev-build number.
   */
  totalRenderMs: number;
  /** Most render time in any one second, so idle time cannot hide a burst. */
  peakSecondRenderMs: number;
  maxCommitMs: number;
  /** Attributed fiber renders; fibers whose name was lost at stop are not counted. */
  fiberRenders: number;
  rerenders: number;
  mounts: number;
  untrackedRenders: number;
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

/** One commit's share of `RenderSummary.totalRenderMs`. */
function commitRenderMs(commit: CommitTiming): number {
  return Math.max(validDuration(commit.durationMs), validDuration(commit.selfMs ?? 0));
}

/** Largest sum of commit render times inside any window of PEAK_WINDOW_MS. */
function peakWindowMs(commitTimings: readonly CommitTiming[]): number {
  const sorted = commitTimings
    .filter((c) => Number.isFinite(c.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  let peak = 0;
  let inWindow = 0;
  let first = 0;
  for (const commit of sorted) {
    inWindow += commitRenderMs(commit);
    while (sorted[first]!.timestamp <= commit.timestamp - PEAK_WINDOW_MS) {
      inWindow -= commitRenderMs(sorted[first]!);
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
    untrackedRenders: number;
    mounts: number;
    mountSelfMs: number;
    lastRerenderCommit: number;
    rerenderCommits: number;
    reasons: Record<ReRenderReason, number>;
    props: Map<string, number>;
    hooks: Map<string, number>;
  }
  const byName = new Map<string, Acc>();
  let fiberRenders = 0;
  let rerenders = 0;
  let mounts = 0;
  let untrackedRenders = 0;

  for (const c of commits) {
    if (!c.didRender) continue;
    fiberRenders++;
    let acc = byName.get(c.componentName);
    if (!acc) {
      acc = {
        rerenders: 0,
        rerenderSelfMs: 0,
        maxRerenderSelfMs: 0,
        untrackedRenders: 0,
        mounts: 0,
        mountSelfMs: 0,
        lastRerenderCommit: -1,
        rerenderCommits: 0,
        reasons: emptyReasonHistogram(),
        props: new Map(),
        hooks: new Map(),
      };
      byName.set(c.componentName, acc);
    }
    const cd = c.changeDescription;
    // The analyze pipeline's reduce stage drops both of these. Here they are
    // counted apart: a context fiber has no change data on any render, so
    // calling it a mount would show one that re-rendered 74 times as 74 mounts.
    if (cd === null) {
      untrackedRenders++;
      acc.untrackedRenders++;
      continue;
    }
    if (cd.isFirstMount === true) {
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
    acc.reasons[deriveReason(cd, c.hookTypes ?? null)]++;
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
    const reason = acc.rerenders > 0 ? dominantReason(acc.reasons) : null;
    const row: RenderSummaryComponent = {
      name,
      rerenders: acc.rerenders,
      untrackedRenders: acc.untrackedRenders,
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
  for (const commit of commitTimings) {
    totalRenderMs += commitRenderMs(commit);
    // The DevTools value alone: the 16 ms floor for a hot commit is defined on it.
    const ms = validDuration(commit.durationMs);
    if (ms > maxCommitMs) maxCommitMs = ms;
  }

  return {
    version: RENDER_SUMMARY_VERSION,
    recordingMs: round2(recordingMs),
    totalCommits: commitTimings.length,
    totalRenderMs: round2(totalRenderMs),
    peakSecondRenderMs: round2(peakWindowMs(commitTimings)),
    // Rounded down: 15.996 ms did not reach the 16 ms floor.
    maxCommitMs: Math.floor(maxCommitMs * 100) / 100,
    fiberRenders,
    rerenders,
    mounts,
    untrackedRenders,
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
    "untrackedRenders",
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
      "untrackedRenders",
      "rerenderCommits",
      "rerenderSelfMs",
      "maxRerenderSelfMs",
      "mounts",
      "mountSelfMs",
    ]) {
      if (!isFiniteNumber(row[key])) return null;
    }
    if (row.reason !== null && typeof row.reason !== "string") return null;
    for (const key of ["topProps", "topHooks"]) {
      if (row[key] !== undefined && !Array.isArray(row[key])) return null;
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

/** Rounded down to 0.1 ms, so a commit under 16 ms never prints as "16.0ms". */
export function formatPeakCommit(ms: number): string {
  return `${(Math.floor(ms * 10) / 10).toFixed(1)}ms`;
}

function formatMs(ms: number): string {
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

/** A name miss against every commit, where `render_counts` lists each name. */
export function renderSummaryNameMiss(
  resolution: Extract<ComponentNameResolution, { kind: "ambiguous" | "missing" }>,
  summary: RenderSummary
): string {
  return renderComponentNameMiss(resolution, {
    fiberRenders: summary.fiberRenders,
    commits: summary.totalCommits,
    nextStep:
      "Run `profiler-commit-query` mode=`render_counts` without `component_name` to list every component.",
  });
}

/** A context provider has no change data on any render, so `untrackedRenders` counts too. */
function allRenderCount(row: RenderSummaryComponent): number {
  return row.rerenders + row.mounts + row.untrackedRenders;
}

/**
 * For a name the stored commits do not hold. It may have rendered only in commits
 * under 16ms, which stop does not keep, so answer from the summary: a component
 * `render_counts` lists must not read as missing from the session.
 */
export function renderNameOutsideStoredCommits(
  query: string,
  summary: RenderSummary,
  nextStep = ""
): string {
  const resolution = resolveComponentName(
    query,
    summary.components.map((c) => c.name)
  );
  if (resolution.kind !== "exact" && resolution.kind !== "display") {
    return renderSummaryNameMiss(resolution, summary);
  }
  const row = summary.components.find((c) => c.name === resolution.rawName)!;
  const renders = allRenderCount(row);
  return (
    `_\`${row.name}\` rendered ${formatCount(renders)} ${renders === 1 ? "time" : "times"} in this session, ` +
    `but never in a stored commit: only commits of 16ms or more and their neighbours are stored._\n\n` +
    `Run \`profiler-commit-query\` mode=\`render_counts\` component_name=\`${row.name}\` for its counts over all commits.${nextStep}`
  );
}

/**
 * `describeResolution` for a name looked up in the stored commits. `Row` can
 * resolve there to `Memo(Row)` while a plain `Row` is its own component in commits
 * that were not stored, so the two names do not mean the same thing.
 */
export function describeStoredResolution(
  resolution: Extract<ComponentNameResolution, { kind: "exact" | "display" }>,
  summary: RenderSummary | null
): string {
  const separate =
    resolution.kind === "display"
      ? summary?.components.find((c) => c.name === resolution.query)
      : undefined;
  if (resolution.kind !== "display" || !separate) return describeResolution(resolution);
  const renders = allRenderCount(separate);
  return (
    `> Showing \`${resolution.rawName}\`, the only stored component named \`${resolution.query}\`. ` +
    `A separate \`${separate.name}\` rendered ${formatCount(renders)} ${renders === 1 ? "time" : "times"} outside the stored commits. ` +
    `Run \`profiler-commit-query\` mode=\`render_counts\` component_name=\`${separate.name}\` for its counts.`
  );
}

/**
 * Only when commits under 16ms hold renders the stored total cannot show.
 * `renderCounts` names where to read them: a tool other than
 * `profiler-commit-query` has to name that tool too.
 */
export function storedOnlyNote(
  name: string,
  storedRenders: number,
  summary: RenderSummary | null,
  renderCounts = "mode=`render_counts`"
): string {
  const row = summary?.components.find((c) => c.name === name);
  if (!summary || !row) return "";
  const allRenders = allRenderCount(row);
  if (allRenders <= storedRenders) return "";
  return (
    ` (stored commits only; ${formatCount(allRenders)} renders over all ` +
    `${formatCount(summary.totalCommits)} commits, see ${renderCounts})`
  );
}

export function formatRenderSummaryReason(c: RenderSummaryComponent): string {
  switch (c.reason) {
    case null:
      return c.mounts > 0 ? "mount only" : "no change data";
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

/** Components that pass the table's numeric limits, before any check of the name. */
function frequentCandidates(summary: RenderSummary): Omit<FrequentRerenderRow, "origin">[] {
  const seconds = Math.max(summary.recordingMs / 1000, 0.001);
  const candidates: Omit<FrequentRerenderRow, "origin">[] = [];
  for (const component of summary.components) {
    if (component.rerenderCommits < MIN_FREQUENT_RERENDER_COMMITS) continue;
    const selfMsPerSecond = component.rerenderSelfMs / seconds;
    if (selfMsPerSecond < MIN_FREQUENT_SELF_MS_PER_S) continue;
    candidates.push({ component, perSecond: component.rerenders / seconds, selfMsPerSecond });
  }
  return candidates;
}

/**
 * App components that re-rendered in at least 10 commits, sorted by summed self
 * time per second, at most five. Library components (React Native primitives,
 * list internals, animation wrappers, providers and contexts, dev-only views)
 * are left out by `classify`; see `component-origin.ts` for how and its limits.
 */
export function selectFrequentRerenders(
  summary: RenderSummary,
  classify: (rawName: string) => ComponentOriginResult,
  limit = MAX_FREQUENT_ROWS
): FrequentRerenderRow[] {
  const rows: FrequentRerenderRow[] = [];
  for (const candidate of frequentCandidates(summary)) {
    const origin = classify(candidate.component.name);
    if (origin.origin !== "library") rows.push({ ...candidate, origin });
  }
  rows.sort((a, b) => b.selfMsPerSecond - a.selfMsPerSecond);
  return rows.slice(0, limit);
}

/**
 * Names that pass the table's limits and are left out only because the source
 * index does not know them. Under a wrong `project_root` that is the app's own
 * components, so the report names them instead of dropping them silently.
 */
export function selectFrequentOutsideSource(
  summary: RenderSummary,
  classify: (rawName: string) => ComponentOriginResult
): string[] {
  return frequentCandidates(summary)
    .map((candidate) => candidate.component.name)
    .filter((name) => classify(name).notInSource);
}
