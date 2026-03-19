export interface ProfilerStartStatus {
  status: "recording";
  pid: number;
  traceFile: string;
}

// ---------------------------------------------------------------------------
// Pipeline internal types
// ---------------------------------------------------------------------------

export interface StackFrame {
  name: string;
  isSystemLibrary: boolean;
}

export interface CpuSample {
  timestampNs: number;
  threadFmt: string;
  weightNs: number;
  stack: StackFrame[];
}

export interface RawHang {
  startNs: number;
  durationNs: number;
  hangType: string;
  threadFmt: string;
}

export interface RawLeak {
  objectType: string;
  sizeBytes: number;
  responsibleFrame: string;
  responsibleLibrary: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Output types (bottlenecks)
// ---------------------------------------------------------------------------

export interface CpuHotspot {
  type: "ios_cpu_hotspot";
  dominantFunction: string;
  totalWeightMs: number;
  weightPercentage: number;
  sampleCount: number;
  thread: string;
  severity: "RED" | "YELLOW";
  /** Representative app call chain for this hotspot */
  topCallChain: string[];
  /** Top 3 most frequent app call chains */
  topCallChains: { chain: string[]; count: number }[];
  /** Whether this function was also seen during a UI hang window */
  duringHang: boolean;
  /** Time range of samples in this hotspot (ms from trace start) */
  timeRangeMs: { first: number; last: number };
  /** Burst windows: clusters of activity separated by >500ms gaps */
  burstWindows: { startMs: number; endMs: number; sampleCount: number }[];
}

export interface UiHang {
  type: "ios_ui_hang";
  hangType: string;
  durationMs: number;
  startTimeFormatted: string;
  suspectedFunctions: string[];
  /** Top app call chains found during the hang window, with sample counts */
  appCallChains: { chain: string[]; sampleCount: number }[];
  severity: "RED" | "YELLOW";
}

export interface MemoryLeak {
  type: "ios_memory_leak";
  objectType: string;
  totalSizeBytes: number;
  count: number;
  responsibleFrame: string;
  responsibleLibrary: string;
  severity: "RED";
}

export type Bottleneck = CpuHotspot | UiHang | MemoryLeak;

export interface ProfilerPayload {
  metadata: {
    traceFile: string | null;
    platform: string;
    timestamp: string;
  };
  bottlenecks: Bottleneck[];
}

export interface IosProfilerAnalyzeResult {
  report: string;
  reportFile: string | null;
  bottlenecksTotal: number;
}
