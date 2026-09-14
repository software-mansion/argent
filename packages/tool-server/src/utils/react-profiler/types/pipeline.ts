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

// First mounts excluded
export interface ComponentAccumulator {
  name: string;
  n: number; // re-render count
  sum: number;
  sumSq: number;
  min: number;
  max: number;
  reasonHistogram: Record<ReRenderReason, number>;
  propFreq: Map<string, number>;
  hookFreq: Map<number, number>;
  hookTypeNames?: string[]; // fiber._debugHookTypes — first non-null wins
  parentFreq: Map<string, number>;
  compilerOptimizedCount: number;
  rootCauseVotes: Map<string, RootCauseVote>; // keyed by parent name
  firstCommitTs: number;
  lastCommitTs: number;
}

// Stage 1: Reduce
export interface ReduceOutput {
  components: Map<string, ComponentAccumulator>;
  reactCommits: number; // distinct commit batches (by commitIndex)
  fiberRenders: number; // didRender entries, first mounts included
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
  normalizedRenderCount: number;
  mean: number;
  min: number;
  max: number;
  totalRenderMs: number;
  dominantReason: ReRenderReason;
  dominantParent?: string;
  topChangedProps: string[];
  topChangedHooks: number[];
  hookTypeNames?: string[];
  isCompilerOptimized: boolean; // >50% of renders were compiler-optimized
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

// Returned by pipeline/index.ts, consumed by react-profiler-analyze.ts
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
