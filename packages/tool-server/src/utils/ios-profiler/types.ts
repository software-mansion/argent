export type {
  CpuHotspot,
  UiHang,
  MemoryLeak,
  MemoryRssGrowth,
  Bottleneck,
  ProfilerPayload,
  UiHangStateBreakdownEntry,
  NativeProfilerAnalyzeResult,
} from "../profiler-shared/types";

// Raw rows produced by pipeline/xml-parser.ts from the xctrace XML export.

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
