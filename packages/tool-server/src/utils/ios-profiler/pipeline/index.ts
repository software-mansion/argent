import type { Bottleneck, CpuSample, UiHang, CpuHotspot, MemoryLeak } from "../types";
import { parseCpuFile, parseHangsFile, parseLeaksFile } from "./xml-parser";
import { correlateHangsWithCpu, aggregateLeaks } from "./01-correlate";
import { aggregateCpuHotspots, toolingWeightNs } from "./02-aggregate";

interface PipelineOutput {
  bottlenecks: Bottleneck[];
  cpuSamples: CpuSample[];
  uiHangs: UiHang[];
  cpuHotspots: CpuHotspot[];
  memoryLeaks: MemoryLeak[];
  /** CPU time of the libraries argent and Instruments load into the app, which the hotspots leave out. */
  toolingCpuMs: { argent: number; instruments: number };
  /** CPU time of the samples with a stack, the tools' included: what the hotspot shares are of. */
  totalCpuMs: number;
}

interface PipelineOptions {
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

  const totalNs = cpuSamples.reduce((sum, s) => sum + (s.stack.length > 0 ? s.weightNs : 0), 0);
  const tooling = toolingWeightNs(cpuSamples);
  return {
    bottlenecks,
    cpuSamples,
    uiHangs,
    cpuHotspots,
    memoryLeaks,
    toolingCpuMs: {
      argent: Math.round(tooling.argent / 1_000_000),
      instruments: Math.round(tooling.instruments / 1_000_000),
    },
    totalCpuMs: Math.round(totalNs / 1_000_000),
  };
}
