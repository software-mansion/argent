import type { Bottleneck, CpuSample, UiHang, CpuHotspot, MemoryLeak } from "../types";
import { parseCpuFile, parseHangsFile, parseLeaksFile } from "./xml-parser";
import { correlateHangsWithCpu, aggregateLeaks } from "./01-correlate";
import { aggregateCpuHotspots } from "./02-aggregate";

export interface PipelineOutput {
  bottlenecks: Bottleneck[];
  cpuSamples: CpuSample[];
  uiHangs: UiHang[];
  cpuHotspots: CpuHotspot[];
  memoryLeaks: MemoryLeak[];
}

export interface PipelineOptions {
  /**
   * iOS-only: keep only CPU samples belonging to this PID. Set by the
   * all-processes capture strategy (host-wide recording) to isolate the target
   * app; undefined/null for the device strategy, which is already scoped.
   */
  cpuFilterPid?: number | null;
}

export async function runIosProfilerPipeline(
  files: Record<string, string | null>,
  options: PipelineOptions = {}
): Promise<PipelineOutput> {
  // Stage 0: Parse all three XMLs in parallel
  const [cpuSamples, rawHangs, rawLeaks] = await Promise.all([
    parseCpuFile(files.cpu ?? null, options.cpuFilterPid ?? null),
    parseHangsFile(files.hangs ?? null),
    parseLeaksFile(files.leaks ?? null),
  ]);

  // Stage 1: Correlate hangs with CPU samples
  const { uiHangs, hangSampleTimestamps } = correlateHangsWithCpu(rawHangs, cpuSamples);

  // Stage 2: Aggregate
  const cpuHotspots = aggregateCpuHotspots(cpuSamples, hangSampleTimestamps);
  const memoryLeaks = aggregateLeaks(rawLeaks);

  // Combine all bottlenecks
  const bottlenecks: Bottleneck[] = [...cpuHotspots, ...uiHangs, ...memoryLeaks];

  return { bottlenecks, cpuSamples, uiHangs, cpuHotspots, memoryLeaks };
}
