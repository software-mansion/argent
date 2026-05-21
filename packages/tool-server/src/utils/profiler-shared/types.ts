/**
 * Cross-platform native profiler types.
 *
 * Originally lived in utils/ios-profiler/types.ts; hoisted here so the Android
 * pipeline can produce the same `Bottleneck` shape without forking the render
 * path. `platform: "ios" | "android"` lets render branches choose row text
 * (e.g. jank reason / state breakdown for Android) without splitting the union.
 *
 * iOS source-compat re-exports remain in utils/ios-profiler/types.ts.
 */

export interface CpuHotspot {
  type: "cpu_hotspot";
  platform: "ios" | "android";
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

export interface UiHangStateBreakdownEntry {
  state: string;
  blockedFunction: string | null;
  durationMs: number;
}

export interface UiHang {
  type: "ui_hang";
  platform: "ios" | "android";
  /** iOS: "hang"/"microhang"; Android: "anr" | "jank" */
  hangType: string;
  durationMs: number;
  startTimeFormatted: string;
  /** Trace-relative nanoseconds — preferred over parsing startTimeFormatted. */
  startNs: number;
  endNs: number;
  suspectedFunctions: string[];
  /** Top app call chains found during the hang window, with sample counts */
  appCallChains: { chain: string[]; sampleCount: number }[];
  severity: "RED" | "YELLOW";
  /** Android-only: FrameTimeline jank_type (AppDeadlineMissed, BufferStuffing, ...) */
  jankReason?: string;
  /** Android-only: main-thread state durations during this hang. */
  stateBreakdown?: UiHangStateBreakdownEntry[];
  /** Android-only: total ART GC slice overlap with the hang window (ms). */
  gcOverlapMs?: number;
}

export interface MemoryLeak {
  type: "memory_leak";
  /** v1: iOS only — Android leak detection is deferred. */
  platform: "ios";
  objectType: string;
  totalSizeBytes: number;
  count: number;
  responsibleFrame: string;
  responsibleLibrary: string;
  severity: "RED";
}

/** Android-only weak signal — never emitted on iOS. */
export interface MemoryRssGrowth {
  type: "memory_rss_growth";
  platform: "android";
  startMb: number;
  peakMb: number;
  growthMb: number;
  /** Always YELLOW — this is a weak signal, not a confirmed leak. */
  severity: "YELLOW";
}

export type Bottleneck = CpuHotspot | UiHang | MemoryLeak | MemoryRssGrowth;

export interface ProfilerPayload {
  metadata: {
    traceFile: string | null;
    platform: string;
    timestamp: string;
  };
  bottlenecks: Bottleneck[];
}

export interface NativeProfilerAnalyzeResult {
  report: string;
  reportFile: string | null;
  bottlenecksTotal: number;
}
