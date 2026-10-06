/**
 * Bottleneck types shared by the iOS and Android profilers. `platform` keeps both
 * in one union; ios-profiler/types.ts re-exports these for source compatibility.
 */

/**
 * Both platform start handlers auto-stop the capture at this point, so a
 * forgotten session can't record unbounded.
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
  topCallChain: string[];
  /** Most frequent first, capped at 3. */
  topCallChains: { chain: string[]; count: number }[];
  /** iOS only: samples overlap a UI hang window. Always false on Android. */
  duringHang: boolean;
  /** ms from trace start */
  timeRangeMs: { first: number; last: number };
  /** Clusters of activity separated by >500ms gaps. */
  burstWindows: { startMs: number; endMs: number; sampleCount: number }[];
  /**
   * Android-only: "system" means emulator/kernel overhead (goldfish/QEMU GPU
   * pipe, syscalls) rather than app code. Drives render labelling and advice.
   */
  frameClass?: "app" | "system";
  /**
   * Android-only: the mapping (loaded object) the dominant leaf lives in. Fed to
   * classifyNativeFrame so `/kernel` leaves with unrecognisable names are still
   * classed as system.
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
  /** Android: "anr" | "jank"; iOS: xctrace's own hang-type label. */
  hangType: string;
  durationMs: number;
  startTimeFormatted: string;
  /** Trace-relative nanoseconds; startTimeFormatted is display-only. */
  startNs: number;
  endNs: number;
  suspectedFunctions: string[];
  /** Top app call chains in the hang window, with sample counts. Empty on Android. */
  appCallChains: { chain: string[]; sampleCount: number }[];
  severity: "RED" | "YELLOW";
  /** Android-only: Perfetto jank_type, e.g. "App Deadline Missed". */
  jankReason?: string;
  /** Android-only: main-thread state durations during this hang. */
  stateBreakdown?: UiHangStateBreakdownEntry[];
  /** Android-only: total ART GC slice overlap with the hang window (ms). */
  gcOverlapMs?: number;
}

export interface MemoryLeak {
  type: "memory_leak";
  /** Android leak detection is not implemented. */
  platform: "ios";
  objectType: string;
  totalSizeBytes: number;
  count: number;
  responsibleFrame: string;
  responsibleLibrary: string;
  /**
   * Whether xctrace resolved a real responsible frame. Without malloc-stack
   * history the frame is `<Call stack limit reached>` and the leak is more
   * likely system noise than a confirmed app leak.
   */
  attributed: boolean;
  /** RED only when attributed; unattributed leaks are a low-confidence YELLOW. */
  severity: "RED" | "YELLOW";
}

export interface MemoryRssGrowth {
  type: "memory_rss_growth";
  platform: "android";
  startMb: number;
  peakMb: number;
  growthMb: number;
  /** Weak signal, not a confirmed leak. */
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
   * Lets callers tell a genuinely clean trace apart from a run where
   * `bottlenecksTotal === 0` only because nothing could be analyzed.
   */
  status: "ok" | "analysis_failed";
  /** Error messages keyed by exporter name. Empty object when `status === "ok"`. */
  exportErrors: Record<string, string>;
}
