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
   * Keep only CPU samples from this PID. Set by the all-processes strategy, whose
   * capture is host-wide; null for the device strategy, already scoped by `--attach`.
   */
  cpuFilterPid?: number | null;
}

export async function runIosProfilerPipeline(
  files: Record<string, string | null>,
  options: PipelineOptions = {}
): Promise<PipelineOutput> {
  const [cpuSamples, rawHangs, rawLeaks] = await Promise.all([
    parseCpuFile(files.cpu ?? null, options.cpuFilterPid ?? null),
    parseHangsFile(files.hangs ?? null),
    parseLeaksFile(files.leaks ?? null),
  ]);

  const { uiHangs, hangSampleTimestamps } = correlateHangsWithCpu(rawHangs, cpuSamples);

  const cpuHotspots = aggregateCpuHotspots(cpuSamples, hangSampleTimestamps);
  const memoryLeaks = aggregateLeaks(rawLeaks);

  const bottlenecks: Bottleneck[] = [...cpuHotspots, ...uiHangs, ...memoryLeaks];

  return { bottlenecks, cpuSamples, uiHangs, cpuHotspots, memoryLeaks };
}
