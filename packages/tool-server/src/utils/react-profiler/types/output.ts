export type ReRenderReason =
  | "parent"
  | "props"
  | "hooks"
  | "context"
  | "state"
  | "force_update"
  | "unknown";

export interface HotCommitComponentEntry {
  name: string;
  selfDurationMs: number; // total across all instances in this commit
  /**
   * Inclusive render time: self + the entire subtree the component owns.
   *
   * With `count > 1` this is the LARGEST single instance's subtree, not a total
   * across them — inclusive times cannot be added across instances, because
   * same-named instances are routinely nested inside one another and the outer
   * one's figure already contains the inner one's. Do not sum this across rows
   * either, for the same reason.
   */
  actualDurationMs: number;
  count: number; // number of fiber instances (>1 = list items etc.)
  isFirstMount?: boolean; // true = initial render (mount), not a re-render
  reason?: ReRenderReason;
  topChangedProps?: string[];
  topChangedHookNames?: string[];
  isCompilerOptimized?: boolean;
}

export interface CpuCommitHotspot {
  name: string;
  selfMs: number;
  totalMs: number;
  url?: string;
  lineNumber?: number;
}

export interface HotCommitSummary {
  commitIndex: number;
  // ms since profile-start (React DevTools sets this as
  // `performance.now() - profilingStartTime`, NOT absolute perf.now).
  timestampMs: number;
  totalRenderMs: number;
  isMargin: boolean;
  tier: "hot" | "warm" | null; // null = margin; hot = >50ms, warm = 16-50ms
  isInitialRender?: boolean; // true when the commit is dominated by first-mount renders
  rootCauseComponent?: string;
  rootCauseReason?: ReRenderReason;
  rootCauseChangedProps?: string[];
  rootCauseChangedHookNames?: string[];
  components: HotCommitComponentEntry[]; // grouped by name, sorted by selfDurationMs DESC (capped at 15)
  totalComponentCount: number; // total before cap (for "... and N more" display)
  cpuHotspots?: CpuCommitHotspot[]; // top JS functions by self-time during this commit's time window
  // ms of actualDuration from fibers whose display name could not be resolved at stop time
  // (transient components unmounted before react-profiler-stop ran). When non-zero, the
  // per-component breakdown is incomplete — this is the size of the hole.
  unattributedMs?: number;
  unattributedFiberCount?: number;
}

export interface ComponentFinding {
  component: string;
  renders: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  dominantReason: ReRenderReason;
  topChangedProps: string[];
  topChangedHookNames: string[];
  isCompilerOptimized?: boolean;
  compilerBailoutSuspected?: boolean;
  parentTrigger?: {
    component: string;
    reason: ReRenderReason;
    changedProps: string[];
    changedHookNames: string[];
    parentChain?: string[];
  };
  sourceLocation?: {
    file: string;
    line: number;
    col: number;
    isMemoized: boolean;
    hasUseCallback: boolean;
    hasUseMemo: boolean;
  };
  sourceSnippet?: string;
}
