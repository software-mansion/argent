export type ReRenderReason =
  | 'parent'
  | 'props'
  | 'hooks'
  | 'context'
  | 'state'
  | 'force_update'
  | 'unknown';

export interface HotCommitComponentEntry {
  name: string;
  selfDurationMs: number;  // total across all instances in this commit
  count: number;           // number of fiber instances (>1 = list items etc.)
  isFirstMount?: boolean;  // true = initial render (mount), not a re-render
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
  timestampMs: number;    // performance.now() from device (absolute)
  totalRenderMs: number;
  isMargin: boolean;
  tier: 'hot' | 'warm' | null;  // null = margin; hot = >50ms, warm = 16-50ms
  isInitialRender?: boolean;    // true when the commit is dominated by first-mount renders
  rootCauseComponent?: string;
  rootCauseReason?: ReRenderReason;
  rootCauseChangedProps?: string[];
  rootCauseChangedHookNames?: string[];
  components: HotCommitComponentEntry[];  // grouped by name, sorted by selfDurationMs DESC (capped at 15)
  totalComponentCount: number;            // total before cap (for "... and N more" display)
  cpuHotspots?: CpuCommitHotspot[];       // top JS functions by self-time during this commit's time window
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
}
