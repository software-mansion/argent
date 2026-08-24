// Hermes CPU profile (CDP Profiler.stop format)
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
  selfTime?: number;
  totalTime?: number;
}

export interface HermesCpuProfile {
  nodes: HermesProfileNode[];
  startTime: number; // microseconds, monotonic
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

// Raw shape returned by `ri.getProfilingData()`, narrowed to the fields
// `flattenProfilingData` and the injected stop-and-read script read.
export interface BackendCommitData {
  timestamp: number; // ms since profiling started
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
  timestamp: number; // ms since profiling started
  componentName: string;
  actualDuration: number; // ms
  selfDuration: number; // ms
  commitDuration: number; // ms for the whole commit — identical on every fiber in it
  didRender: boolean;
  changeDescription: DevToolsChangeDescription | null;
  hookTypes?: string[] | null; // fiber._debugHookTypes — dev builds only
  parentName?: string | null; // nearest named ancestor component
  isCompilerOptimized?: boolean;
  // Set by Stage 0 (00-preprocess) for parent-cascade tracing
  rootCauseParent?: string;
  rootCauseReason?: import("./output.js").ReRenderReason;
  rootCauseProps?: string[] | null;
  rootCauseHooks?: number[] | null;
  rootCauseHookTypes?: string[] | null;
  rootCauseChain?: string[]; // full chain: [immediateParent, ..., rootCauseParent]
}

export interface DevToolsCommitTree {
  commits: DevToolsFiberCommit[];
  hookNames?: Map<number, string>;
}

// Top-level raw input to the pipeline
export interface RawProfilingInput {
  flamegraph?: HermesCpuProfile;
  commitTree: DevToolsCommitTree;
  sessionMeta: {
    recordingDurationMs: number;
    deviceId: string;
    platform: "ios" | "android";
    rnVersion: string;
    projectRoot: string;
    detectedArchitecture?: "bridge" | "bridgeless";
    anyCompilerOptimized?: boolean; // pre-scanned in react-profiler-stop before hot filtering
    hotCommitIndices?: number[]; // commits whose heat reached the 16ms floor
    allClear?: boolean; // every commit stayed under the 16ms floor
    maxCommitMs?: number; // max commit heat when allClear=true
    totalReactCommits?: number; // all commit batches, including ones hot filtering dropped
    unattributedByCommit?: Array<[number, number, number]>;
  };
}
