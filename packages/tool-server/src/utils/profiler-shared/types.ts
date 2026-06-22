/**
 * Cross-platform native profiler types — the home of the iOS/Android symmetry.
 *
 * Hoisted from utils/ios-profiler/types.ts so the Android pipeline produces the
 * same `Bottleneck` shape without forking the render path. `platform` lets
 * render branches choose row text (jank reason / state breakdown for Android)
 * without splitting the union. iOS source-compat re-exports stay in ios-profiler/types.ts.
 */

/**
 * Hard cap on a native profiler recording's wall-clock duration. After this the
 * platform start handlers auto-stop the capture so a forgotten session can't run
 * unbounded. Shared by the Android and iOS start paths.
 */
export const RECORDING_CAP_MS = 10 * 60 * 1000;

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
  /**
   * Android-only: whether the dominant frame is app code ("app") or
   * system/emulator overhead ("system") such as the goldfish/QEMU GPU pipe or
   * a kernel syscall. Drives the labelling and advice in the render layer.
   * Undefined on iOS.
   */
  frameClass?: "app" | "system";
  /**
   * Android-only: the mapping (loaded object) the dominant leaf lives in —
   * `/kernel` for kernel frames, a real module path for user space. Fed to
   * classifyNativeFrame so kernel leaves with unrecognisable names are still
   * classed as system. Undefined on iOS (no mapping in the iOS sample data).
   */
  dominantMapping?: string;
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
  /**
   * "ok" when every analyzer query/export succeeded; "analysis_failed" when
   * one or more entries are present in `exportErrors`. Lets MCP/CLI callers
   * tell a truly clean trace apart from a run where queries blew up and
   * `bottlenecksTotal === 0` only because nothing could be analyzed.
   */
  status: "ok" | "analysis_failed";
  /**
   * Per-exporter error messages keyed by exporter name (Android: cpu/hangs/rss;
   * iOS: cpu/hangs/leaks). Empty object when `status === "ok"`.
   */
  exportErrors: Record<string, string>;
}
