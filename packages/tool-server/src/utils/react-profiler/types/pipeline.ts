import type { ReRenderReason, HotCommitSummary, ComponentFinding } from "./output.js";

export type { ReRenderReason };

export interface SessionContext {
  reactCompilerEnabled: boolean;
  strictModeEnabled: boolean;
  buildMode: "dev" | "prod";
  rnArchitecture: "bridge" | "bridgeless";
  projectRoot: string;
  platform: "ios" | "android";
}

/** Accumulated root cause data for a single parent candidate */
export interface RootCauseVote {
  count: number;
  reason: ReRenderReason;
  changedProps: string[];
  changedHooks: number[];
  hookTypes: string[] | null;
  chain: string[]; // full chain: [immediateParent, ..., rootCauseParent]
}

// Welford accumulator for one component (first mounts excluded)
export interface ComponentAccumulator {
  name: string;
  n: number; // re-render count (first mounts stripped)
  sum: number; // sum of actualDuration
  sumSq: number; // sum of actualDuration^2
  min: number;
  max: number;
  reasonHistogram: Record<ReRenderReason, number>;
  propFreq: Map<string, number>;
  hookFreq: Map<number, number>;
  hookTypeNames?: string[]; // fiber._debugHookTypes — first non-null wins
  parentFreq: Map<string, number>; // parent component name → frequency
  compilerOptimizedCount: number; // renders where isCompilerOptimized=true
  rootCauseVotes: Map<string, RootCauseVote>; // parent name → root cause vote data
  firstCommitTs: number; // ms (performance.now reference)
  lastCommitTs: number;
}

// Stage 1: Reduce
export interface ReduceOutput {
  components: Map<string, ComponentAccumulator>;
  reactCommits: number; // unique React commit batch count (by commitIndex)
  fiberRenders: number; // total fiber render entries processed
  anyRuntimeCompilerDetected: boolean;
  totalFirstMounts: number;
  firstMountOnlyComponents: string[];
  sessionContext: SessionContext;
  recordingMs: number;
}

// Stage 2: Enrich
export interface EnrichedComponent {
  name: string;
  n: number;
  normalizedRenderCount: number; // n/2 if strictMode, else n
  mean: number;
  min: number;
  max: number;
  totalRenderMs: number;
  dominantReason: ReRenderReason;
  dominantParent?: string;
  topChangedProps: string[];
  topChangedHooks: number[];
  hookTypeNames?: string[];
  isCompilerOptimized: boolean; // >50% of renders showed useMemoCache
  parentTrigger?: {
    component: string;
    reason: ReRenderReason;
    changedProps: string[];
    changedHooks: number[];
    changedHookNames: string[];
    parentChain?: string[]; // [immediateParent, ..., rootCause]; only when chain has >1 hop
  };
  firstCommitTs: number;
  lastCommitTs: number;
}

export interface EnrichOutput {
  components: Map<string, EnrichedComponent>;
  sessionContext: SessionContext;
  reactCommits: number;
  fiberRenders: number;
  anyRuntimeCompilerDetected: boolean;
  totalFirstMounts: number;
  firstMountOnlyComponents: string[];
  recordingMs: number;
}

// Stage 3: Tag
export interface TaggedComponent extends EnrichedComponent {
  isAnimated: boolean;
  isRecyclerChild: boolean;
}

export interface TagOutput {
  components: Map<string, TaggedComponent>;
  sessionContext: SessionContext;
  reactCommits: number;
  fiberRenders: number;
  anyRuntimeCompilerDetected: boolean;
  totalFirstMounts: number;
  firstMountOnlyComponents: string[];
  recordingMs: number;
}

// Final pipeline output (returned by pipeline/index.ts, consumed by react-profiler-analyze.ts)
export interface PipelineOutput {
  hotCommitSummaries: HotCommitSummary[];
  componentFindings: ComponentFinding[];
  sessionContext: SessionContext;
  recordingMs: number;
  allClear: boolean;
  maxCommitMs?: number;
  anyRuntimeCompilerDetected: boolean;
  reactCommits: number;
  fiberRenders: number;
  totalFirstMounts: number;
  cpuSampleIndex?: import("../pipeline/00-cpu-correlate.js").CpuSampleIndex | null;
}
