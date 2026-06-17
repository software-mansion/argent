import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import type { CpuSample, UiHang, CpuHotspot, MemoryLeak } from "../../../utils/ios-profiler/types";
import {
  findDominantFunction,
  extractAppCallChain,
} from "../../../utils/ios-profiler/pipeline/02-aggregate";
import {
  runAndroidStackQuery,
  type AndroidStackQueryMode,
} from "../../../utils/android-profiler/pipeline/index";
import { normalizeThreadName } from "../../../utils/profiler-shared/thread";
import { formatBytes } from "../../../utils/profiler-shared/format";

const zodSchema = z.object({
  device_id: z.string().describe("iOS Simulator UDID or Android serial."),
  mode: z
    .enum(["hang_stacks", "function_callers", "thread_breakdown", "leak_stacks"])
    .describe(
      "Query mode: hang_stacks (full CPU context during a hang), function_callers (who calls a native function), " +
        "thread_breakdown (CPU split by thread), leak_stacks (leak details by object type)"
    ),
  hang_index: z.coerce
    .number()
    .int()
    .optional()
    .describe("0-based index into the hang list for hang_stacks mode"),
  function_name: z.string().optional().describe("Function name for function_callers mode"),
  thread: z
    .string()
    .optional()
    .describe(
      "Thread filter. thread_breakdown: case-insensitive substring match. " +
        'function_callers: exact raw thread name (e.g. ".blueskyweb.app"), or "main" for ' +
        "the UI thread; omit to search ALL threads (each result is tagged with its thread). " +
        "Run thread_breakdown first to see the exact raw names."
    ),
  object_type: z.string().optional().describe("Object type filter for leak_stacks mode"),
  top_n: z.coerce
    .number()
    .int()
    .positive()
    .default(15)
    .describe("Max results to return (default 15)"),
});

function getIosParsedData(api: NativeProfilerSessionApi) {
  if (!api.parsedData) {
    throw new Error(
      "No parsed trace data. Run native-profiler-stop → native-profiler-analyze first."
    );
  }
  return api.parsedData;
}

function renderHangStacksIos(
  cpuSamples: CpuSample[],
  uiHangs: UiHang[],
  hangIndex: number,
  topN: number
): string {
  if (hangIndex < 0 || hangIndex >= uiHangs.length) {
    return `_Invalid hang_index ${hangIndex}. There are ${uiHangs.length} hangs (0-indexed)._`;
  }

  const hang = uiHangs[hangIndex]!;
  const suspectedSet = new Set(hang.suspectedFunctions);

  const lines: string[] = [
    `## Hang #${hangIndex} — ${hang.hangType} (${hang.durationMs}ms at ${hang.startTimeFormatted})`,
    "",
    `**Severity:** ${hang.severity}`,
    "",
  ];

  if (hang.suspectedFunctions.length > 0) {
    lines.push("### Suspected Functions (by sample frequency)");
    lines.push("");
    for (let i = 0; i < hang.suspectedFunctions.length; i++) {
      lines.push(`${i + 1}. \`${hang.suspectedFunctions[i]}\``);
    }
    lines.push("");
  }

  if (hang.appCallChains.length > 0) {
    lines.push("### App Call Chains During Hang");
    lines.push("");
    for (const { chain, sampleCount } of hang.appCallChains) {
      lines.push(`- (${sampleCount} samples) ${chain.map((f) => `\`${f}\``).join(" → ")}`);
    }
    lines.push("");
  }

  const relatedSamples = cpuSamples.filter((s) => {
    const dominant = findDominantFunction(s.stack);
    return dominant !== null && suspectedSet.has(dominant);
  });

  if (relatedSamples.length > 0) {
    lines.push("### Full Stack Samples (matching suspected functions)");
    lines.push("");

    const uniqueStacks = new Map<string, { stack: string[]; count: number }>();
    for (const sample of relatedSamples) {
      const chain = extractAppCallChain(sample.stack);
      const key = chain.join(" > ");
      const existing = uniqueStacks.get(key);
      if (existing) {
        existing.count++;
      } else {
        uniqueStacks.set(key, { stack: chain, count: 1 });
      }
    }

    const sorted = [...uniqueStacks.values()].sort((a, b) => b.count - a.count).slice(0, topN);
    for (const { stack, count } of sorted) {
      lines.push(`- (${count}×) ${stack.map((f) => `\`${f}\``).join(" → ")}`);
    }
  }

  return lines.join("\n");
}

function renderFunctionCallersIos(
  cpuSamples: CpuSample[],
  functionName: string,
  topN: number
): string {
  const callerCounts = new Map<string, number>();
  const calleeCounts = new Map<string, number>();
  let totalOccurrences = 0;

  for (const sample of cpuSamples) {
    for (let i = 0; i < sample.stack.length; i++) {
      if (sample.stack[i]!.name === functionName) {
        totalOccurrences++;

        if (i + 1 < sample.stack.length) {
          const caller = sample.stack[i + 1]!.name;
          callerCounts.set(caller, (callerCounts.get(caller) ?? 0) + 1);
        }

        if (i - 1 >= 0) {
          const callee = sample.stack[i - 1]!.name;
          calleeCounts.set(callee, (calleeCounts.get(callee) ?? 0) + 1);
        }

        break;
      }
    }
  }

  if (totalOccurrences === 0) {
    return `_Function \`${functionName}\` not found in any CPU sample stack._`;
  }

  const lines: string[] = [
    `## Native Call Context for \`${functionName}\``,
    "",
    `**Occurrences in samples:** ${totalOccurrences}`,
    "",
  ];

  const sortedCallers = [...callerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  if (sortedCallers.length > 0) {
    lines.push("### Called By");
    lines.push("");
    lines.push("| Function | Samples |");
    lines.push("|---|---|");
    for (const [name, count] of sortedCallers) {
      lines.push(`| \`${name}\` | ${count} |`);
    }
    lines.push("");
  }

  const sortedCallees = [...calleeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  if (sortedCallees.length > 0) {
    lines.push("### Calls Into");
    lines.push("");
    lines.push("| Function | Samples |");
    lines.push("|---|---|");
    for (const [name, count] of sortedCallees) {
      lines.push(`| \`${name}\` | ${count} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderThreadBreakdownIos(
  cpuSamples: CpuSample[],
  cpuHotspots: CpuHotspot[],
  threadFilter: string | undefined,
  topN: number
): string {
  const threadWeight = new Map<string, number>();
  const threadSamples = new Map<string, number>();

  for (const sample of cpuSamples) {
    const thread = normalizeThreadName(sample.threadFmt);
    if (threadFilter && !thread.toLowerCase().includes(threadFilter.toLowerCase())) continue;
    threadWeight.set(thread, (threadWeight.get(thread) ?? 0) + sample.weightNs);
    threadSamples.set(thread, (threadSamples.get(thread) ?? 0) + 1);
  }

  const totalWeight = [...threadWeight.values()].reduce((a, b) => a + b, 0);

  const sorted = [...threadWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);

  if (sorted.length === 0) {
    return threadFilter
      ? `_No samples found for thread matching "${threadFilter}"._`
      : "_No CPU samples available._";
  }

  const lines: string[] = [
    `## Thread CPU Breakdown${threadFilter ? ` (filter: "${threadFilter}")` : ""}`,
    "",
    "| Thread | Weight (ms) | % | Samples |",
    "|---|---|---|---|",
  ];

  for (const [thread, weight] of sorted) {
    const weightMs = Math.round(weight / 1_000_000);
    const pct = totalWeight > 0 ? ((weight / totalWeight) * 100).toFixed(1) : "0";
    const samples = threadSamples.get(thread) ?? 0;
    lines.push(`| ${thread} | ${weightMs} | ${pct}% | ${samples} |`);
  }

  if (threadFilter) {
    const threadHotspots = cpuHotspots.filter((h) =>
      h.thread.toLowerCase().includes(threadFilter.toLowerCase())
    );
    if (threadHotspots.length > 0) {
      lines.push("");
      lines.push("### Hotspots on This Thread");
      lines.push("");
      lines.push("| Function | Weight (ms) | % | During Hang |");
      lines.push("|---|---|---|---|");
      for (const h of threadHotspots.slice(0, topN)) {
        lines.push(
          `| \`${h.dominantFunction}\` | ${h.totalWeightMs} | ${h.weightPercentage}% | ${h.duringHang ? "Yes" : "No"} |`
        );
      }
    }
  }

  return lines.join("\n");
}

function renderLeakStacksIos(
  memoryLeaks: MemoryLeak[],
  objectTypeFilter: string | undefined,
  topN: number
): string {
  let filtered = memoryLeaks;
  if (objectTypeFilter) {
    filtered = memoryLeaks.filter((l) =>
      l.objectType.toLowerCase().includes(objectTypeFilter.toLowerCase())
    );
  }

  if (filtered.length === 0) {
    return objectTypeFilter
      ? `_No leaks found matching "${objectTypeFilter}"._`
      : "_No memory leaks detected._";
  }

  const sorted = [...filtered].sort((a, b) => b.totalSizeBytes - a.totalSizeBytes).slice(0, topN);

  const totalBytes = sorted.reduce((s, l) => s + l.totalSizeBytes, 0);
  const totalCount = sorted.reduce((s, l) => s + l.count, 0);

  const lines: string[] = [
    `## Memory Leaks${objectTypeFilter ? ` (filter: "${objectTypeFilter}")` : ""}`,
    "",
    `**Total:** ${formatBytes(totalBytes)} across ${totalCount} allocations`,
    "",
    "| Object Type | Size | Count | Responsible Frame | Library |",
    "|---|---|---|---|---|",
  ];

  for (const l of sorted) {
    lines.push(
      `| \`${l.objectType}\` | ${formatBytes(l.totalSizeBytes)} | ${l.count} | \`${l.responsibleFrame}\` | ${l.responsibleLibrary || "—"} |`
    );
  }

  return lines.join("\n");
}

async function executeIos(api: NativeProfilerSessionApi, params: z.infer<typeof zodSchema>) {
  const data = getIosParsedData(api);
  switch (params.mode) {
    case "hang_stacks": {
      if (params.hang_index == null) {
        throw new Error("hang_stacks mode requires the hang_index parameter.");
      }
      return renderHangStacksIos(data.cpuSamples, data.uiHangs, params.hang_index, params.top_n);
    }
    case "function_callers": {
      if (!params.function_name) {
        throw new Error("function_callers mode requires the function_name parameter.");
      }
      return renderFunctionCallersIos(data.cpuSamples, params.function_name, params.top_n);
    }
    case "thread_breakdown":
      return renderThreadBreakdownIos(
        data.cpuSamples,
        data.cpuHotspots,
        params.thread,
        params.top_n
      );
    case "leak_stacks":
      return renderLeakStacksIos(data.memoryLeaks, params.object_type, params.top_n);
    default:
      throw new Error(`Unknown mode: ${params.mode}`);
  }
}

async function executeAndroid(api: NativeProfilerSessionApi, params: z.infer<typeof zodSchema>) {
  if (!api.exportedFiles?.pftrace || !api.traceFile) {
    throw new Error(
      "No Android trace loaded. Run native-profiler-stop → native-profiler-analyze first."
    );
  }
  if (params.mode === "leak_stacks") {
    return "_Memory leak detection is not yet supported on Android. Use the RSS-growth weak signal in the analyze report as a hint, or capture a heap dump manually with `adb shell am dumpheap`._";
  }
  return runAndroidStackQuery({
    tracePath: api.traceFile,
    mode: params.mode as AndroidStackQueryMode,
    appPackage: api.appProcess ?? "",
    hangIndex: params.hang_index,
    functionName: params.function_name,
    thread: params.thread,
    topN: params.top_n,
  });
}

export const profilerStackQueryTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "profiler-stack-query",
  description: `Query native profiler trace data for iterative investigation of native performance.
Requires native-profiler-stop → native-profiler-analyze to have been called first.
Modes:
- hang_stacks: Full CPU context during a specific hang (by hang_index).
- function_callers: Who calls a specific native function and what it calls.
- thread_breakdown: CPU time split by thread, optionally filtered.
- leak_stacks: Memory leak details (iOS only), optionally filtered by object_type.
Use when drilling into native hang stacks, thread CPU breakdown, or memory leaks after native-profiler-analyze.
Returns a markdown report with native call stacks, thread weights, or leak details for the selected mode.
Fails if native-profiler-analyze has not been run or no parsed trace data is in memory.`,
  zodSchema,
  // iOS: reads xctrace output. Android: queries the Perfetto .pftrace via the
  // in-process trace-processor engine (see executeAndroid). Chromium has no
  // native trace capture.
  capability: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
  },
  services: (params) => ({
    session: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params) {
    const api = services.session as NativeProfilerSessionApi;
    if (api.platform === "android") {
      return executeAndroid(api, params);
    }
    return executeIos(api, params);
  },
};
