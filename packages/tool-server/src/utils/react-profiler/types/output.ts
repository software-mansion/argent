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
  // Inclusive: self + subtree. Never sum across siblings — parents already count children.
  actualDurationMs: number;
  count: number; // fiber instances with this name (>1 = list items)
  isFirstMount?: boolean; // only when every instance in the group was a mount
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
  // ms since profile start, not absolute performance.now()
  timestampMs: number;
  totalRenderMs: number;
  isMargin: boolean;
  tier: "hot" | "warm" | null; // null = margin; hot = >50ms, warm = 16-50ms
  isInitialRender?: boolean; // first-mount self time exceeds half the commit
  rootCauseComponent?: string;
  rootCauseReason?: ReRenderReason;
  rootCauseChangedProps?: string[];
  rootCauseChangedHookNames?: string[];
  components: HotCommitComponentEntry[]; // grouped by name, self-time DESC, capped at 15
  totalComponentCount: number; // before the cap; drives the "... and N more" line
  cpuHotspots?: CpuCommitHotspot[]; // top JS functions by self time in this commit's window
  // self time of fibers whose name was lost before stop — the hole in `components`
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
