/**
 * iOS-specific raw row types (`StackFrame`, `CpuSample`, `RawHang`, `RawLeak`)
 * plus re-exports of the shared `Bottleneck` family. The cross-platform types
 * live in profiler-shared/types.ts (the iOS/Android symmetry home).
 */

export type {
  CpuHotspot,
  UiHang,
  MemoryLeak,
  MemoryRssGrowth,
  Bottleneck,
  ProfilerPayload,
  UiHangStateBreakdownEntry,
  NativeProfilerAnalyzeResult,
  NativeProfilerAnalyzeResult as IosProfilerAnalyzeResult,
} from "../profiler-shared/types";

export interface ProfilerStartStatus {
  status: "recording";
  pid: number;
  traceFile: string;
}

// ---------------------------------------------------------------------------
// iOS pipeline-internal raw types (xctrace XML parser output)
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
