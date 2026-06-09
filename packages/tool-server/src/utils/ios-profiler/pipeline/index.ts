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

/**
 * Keep only samples whose thread fmt belongs to `pid`. A host all-processes
 * trace contains every process on the machine; xctrace tags each thread fmt
 * with `(AppName, pid: N)`, so matching on `pid: N` scopes the trace to the
 * profiled app. A no-op when `pid` is null (device-attach traces already
 * contain only the attached app).
 */
export function filterSamplesByPid<T extends { threadFmt: string }>(
  samples: T[],
  pid: string | null
): T[] {
  if (!pid) return samples;
  // `pid: 52533)` — anchor on the closing paren so 52533 never matches 525330.
  const needle = `pid: ${pid})`;
  return samples.filter((s) => s.threadFmt.includes(needle));
}

export async function runIosProfilerPipeline(
  files: Record<string, string | null>,
  processFilterPid: string | null = null
): Promise<PipelineOutput> {
  // Stage 0: Parse all three XMLs in parallel
  const [allCpuSamples, allRawHangs, rawLeaks] = await Promise.all([
    parseCpuFile(files.cpu ?? null),
    parseHangsFile(files.hangs ?? null),
    parseLeaksFile(files.leaks ?? null),
  ]);

  // Stage 0.5: Scope to the profiled app's PID for host all-processes traces.
  const cpuSamples = filterSamplesByPid(allCpuSamples, processFilterPid);
  const rawHangs = filterSamplesByPid(allRawHangs, processFilterPid);

  // Stage 1: Correlate hangs with CPU samples
  const { uiHangs, hangSampleTimestamps } = correlateHangsWithCpu(rawHangs, cpuSamples);

  // Stage 2: Aggregate
  const cpuHotspots = aggregateCpuHotspots(cpuSamples, hangSampleTimestamps);
  const memoryLeaks = aggregateLeaks(rawLeaks);

  // Combine all bottlenecks
  const bottlenecks: Bottleneck[] = [...cpuHotspots, ...uiHangs, ...memoryLeaks];

  return { bottlenecks, cpuSamples, uiHangs, cpuHotspots, memoryLeaks };
}
