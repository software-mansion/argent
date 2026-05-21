/**
 * iOS-specific profiler types and re-exports of the shared `Bottleneck` family.
 *
 * The cross-platform Bottleneck/CpuHotspot/UiHang/MemoryLeak/MemoryRssGrowth
 * types live in utils/profiler-shared/types.ts so the Android pipeline can
 * produce the same shape without forking the render path. This file keeps the
 * iOS-only raw row types (`StackFrame`, `CpuSample`, `RawHang`, `RawLeak`)
 * and re-exports the shared union for existing callers.
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
