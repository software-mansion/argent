// Hermes CPU profile node (CDP Profiler.stop format)
export interface HermesCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface HermesProfileNode {
  id: number;
  callFrame: HermesCallFrame;
  hitCount: number;
  children?: number[];
  selfTime?: number; // microseconds
  totalTime?: number; // microseconds
}

export interface HermesCpuProfile {
  nodes: HermesProfileNode[];
  startTime: number; // microseconds, monotonic
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

// Raw shape returned by `ri.getProfilingData()` — only the fields we actually
// read in `flattenProfilingData` and the injected stop-and-read script. The
// React DevTools backend emits more (priorityLevel, effectDuration, rootID,
// rendererID, timelineData, …) but we never consume those, so they're omitted.
export interface BackendCommitData {
  timestamp: number; // ms since the `startProfiling` call
  duration?: number;
  fiberActualDurations?: Array<[number, number]>;
  fiberSelfDurations?: Array<[number, number]>;
  changeDescriptions?: Array<[number, unknown]>;
}

export interface BackendRootData {
  commitData: BackendCommitData[];
}

export interface ProfilingDataBackend {
  dataForRoots: BackendRootData[];
}

// React DevTools ProfilingData shape
export interface DevToolsChangeDescription {
  props: string[] | null; // changed prop names
  state: boolean | null;
  hooks: number[] | null; // changed hook indices
  context: boolean | null;
  didHooksChange: boolean;
  isFirstMount: boolean;
}

export interface DevToolsFiberCommit {
  commitIndex: number;
  timestamp: number; // ms, React internal clock (performance.now)
  componentName: string;
  actualDuration: number; // ms
  selfDuration: number; // ms
  commitDuration: number; // ms — root.current.actualDuration (total wall time for this commit)
  didRender: boolean;
  changeDescription: DevToolsChangeDescription | null;
  hookTypes?: string[] | null; // fiber._debugHookTypes — available in dev builds
  parentName?: string | null; // nearest named ancestor component
  isCompilerOptimized?: boolean; // true if fiber._debugHookTypes contains 'useMemoCache'
  // Annotated by Stage 0 (preprocess) for parent-cascade root cause tracing
  rootCauseParent?: string;
  rootCauseReason?: import("./output.js").ReRenderReason;
  rootCauseProps?: string[] | null;
  rootCauseHooks?: number[] | null;
  rootCauseHookTypes?: string[] | null;
  rootCauseChain?: string[]; // full chain: [immediateParent, ..., rootCauseParent]
}

export interface DevToolsCommitTree {
  commits: DevToolsFiberCommit[];
  hookNames?: Map<number, string>; // hook index → name if available
}

// Top-level raw input to the pipeline
export interface RawProfilingInput {
  flamegraph?: HermesCpuProfile; // optional — used only for buildMode detection in session-context
  commitTree: DevToolsCommitTree;
  sessionMeta: {
    recordingDurationMs: number;
    deviceId: string;
    platform: "ios" | "android";
    rnVersion: string;
    projectRoot: string; // needed for AST resolution in stage 6
    detectedArchitecture?: "bridge" | "bridgeless";
    anyCompilerOptimized?: boolean; // pre-scanned in react-profiler-stop before hot filtering
    hotCommitIndices?: number[]; // commit indices selected as "interesting" (≥16ms absolute floor)
    allClear?: boolean; // true if all commits were below 16ms floor
    maxCommitMs?: number; // max commit heat when allClear=true
    totalReactCommits?: number; // total unique commit batches (for accurate all-clear display)
    // Per-commit tuples [commitIndex, droppedFiberCount, droppedActualDurationMs] for
    // fibers the stop-time name resolver could not identify (transient/unmounted components).
    unattributedByCommit?: Array<[number, number, number]>;
  };
}
