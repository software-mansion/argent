export type {
  CpuHotspot,
  UiHang,
  MemoryLeak,
  MemoryRssGrowth,
  Bottleneck,
  ProfilerPayload,
  NativeProfilerAnalyzeResult,
} from "../profiler-shared/types";

import type { ToolingOwner } from "./config";

// Raw rows produced by pipeline/xml-parser.ts from the xctrace XML export.

export interface StackFrame {
  name: string;
  isSystemLibrary: boolean;
  /** Set for a frame in a library that argent or Instruments loads into the app (TOOLING_LIBRARIES). */
  tooling?: ToolingOwner;
  /** File name of the frame's binary, such as `AppKit` or `libobjc.A.dylib`, when the export gives one. */
  library?: string;
  /** Path of the frame's binary, set with `library`. */
  libraryPath?: string;
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
