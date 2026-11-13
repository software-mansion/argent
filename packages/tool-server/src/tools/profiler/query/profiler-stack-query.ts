import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { adbCommandPrefix } from "../../../utils/adb-server";
import type {
  CpuSample,
  UiHang,
  CpuHotspot,
  MemoryLeak,
  StackFrame,
} from "../../../utils/ios-profiler/types";
import {
  findDominantFunction,
  extractAppCallChain,
  isSystemCodeSample,
  toolingWork,
} from "../../../utils/ios-profiler/pipeline/02-aggregate";
import {
  runAndroidStackQuery,
  type AndroidStackQueryMode,
} from "../../../utils/android-profiler/pipeline/index";
import { normalizeThreadName } from "../../../utils/profiler-shared/thread";
import { formatBytes, escapeMarkdownTableCell } from "../../../utils/profiler-shared/format";
import { demangleSymbol } from "../../../utils/profiler-shared/demangle";
import {
  LEAKS_NOT_RECORDED,
  hangChainNames,
  hangFunctionCode,
  waitedHangNote,
  hangSuspendedNote,
  hotspotName,
  renderSystemLibraryLeaksNote,
  renderUnattributedLeaksNote,
} from "../../../utils/ios-profiler/render";
import { metroDeviceIdParam } from "../../../utils/debugger/device-id-param";
import { leakRank } from "../../../utils/ios-profiler/pipeline/01-correlate";

const stackQueryMode = {
  hang_stacks: "hang stacks",
  function_callers: "function callers",
  thread_breakdown: "thread breakdown",
  leak_stacks: "leak stacks",
} satisfies Record<Params["mode"], string>;

function getIosParsedData(api: NativeProfilerSessionApi) {
  if (!api.parsedData) {
    throw new FailureError(
      "No parsed trace data. Run native-profiler-stop → native-profiler-analyze first.",
      {
        error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
        failure_stage: "profiler_stack_query_load_data",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  return api.parsedData;
}

export function renderHangStacksIos(
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
    `## Hang #${hangIndex} — ${hang.hangType} (${hang.durationMs}ms at ${hang.startTimeFormatted}${hangSuspendedNote(hang)})`,
    "",
    `**Severity:** ${hang.severity}`,
    "",
  ];
  if (hang.hangThreadRanMs !== undefined) lines.push(waitedHangNote(hang), "");

  if (hang.suspectedFunctions.length > 0) {
    lines.push("### Suspected Functions (by sample frequency)");
    lines.push("");
    for (let i = 0; i < hang.suspectedFunctions.length; i++) {
      lines.push(`${i + 1}. ${hangFunctionCode(hang, hang.suspectedFunctions[i]!)}`);
    }
    lines.push("");
  }

  if (hang.appCallChains.length > 0) {
    lines.push("### App Call Chains During Hang");
    lines.push("");
    for (const { chain, sampleCount } of hang.appCallChains) {
      lines.push(
        `- (${sampleCount} samples) ${hangChainNames(hang, chain)
          .map(({ name, label }) => `\`${name}\`${label ? ` (${label})` : ""}`)
          .join(" → ")}`
      );
    }
    lines.push("");
  }

  // The recorder's samples are not the app's work, as in the suspects (01-correlate).
  const relatedSamples = cpuSamples.filter((s) => {
    if (toolingWork(s.stack) === "instruments") return false;
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
      lines.push(`- (${count}×) ${stack.map((f) => `\`${demangleSymbol(f)}\``).join(" → ")}`);
    }
  }

  return lines.join("\n");
}

export function renderFunctionCallersIos(
  cpuSamples: CpuSample[],
  functionName: string,
  topN: number
): string {
  const callerCounts = new Map<string, number>();
  const calleeCounts = new Map<string, number>();
  let totalOccurrences = 0;
  // Root first: the frames below the function in each sample of system code reported under it.
  const systemPathsBelow: StackFrame[][] = [];

  for (const sample of cpuSamples) {
    for (let i = 0; i < sample.stack.length; i++) {
      if (sample.stack[i]!.name === functionName) {
        totalOccurrences++;
        // As in the hotspot: a tool's work (such as Instruments' recorder) is not counted.
        if (
          findDominantFunction(sample.stack) === functionName &&
          isSystemCodeSample(sample.stack) &&
          toolingWork(sample.stack) === null
        ) {
          systemPathsBelow.push(sample.stack.slice(0, i).reverse());
        }

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
      lines.push(`| \`${escapeMarkdownTableCell(demangleSymbol(name))}\` | ${count} |`);
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
      lines.push(`| \`${escapeMarkdownTableCell(demangleSymbol(name))}\` | ${count} |`);
    }
    lines.push("");
  }

  // The report's "system code under" this function has no app frame to name: the
  // heaviest stack of those samples shows what the system code did.
  const heaviest = heaviestStackBelow(systemPathsBelow, topN);
  if (heaviest.length > 0) {
    lines.push("### Heaviest System Stack Below");
    lines.push("");
    lines.push(
      `In the ${systemPathsBelow.length} samples with only system code below the function: ` +
        "from the function down, the heaviest callee at each level. Frames that run in the " +
        "same samples share a row."
    );
    lines.push("");
    lines.push("| Frames | Samples | % |");
    lines.push("|---|---|---|");
    for (const { frames, count } of heaviest) {
      const names = frames.map((f) => `\`${escapeMarkdownTableCell(demangleSymbol(f))}\``);
      const pct = ((count / systemPathsBelow.length) * 100).toFixed(1);
      lines.push(`| ${names.join(" > ")} | ${count} | ${pct}% |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Instruments' heaviest stack trace below a function: from the paths below it (root
 * first), the callee in the most samples at each level, down to a leaf. A run of frames
 * in the same samples is one row. At most `maxRows` rows, and none under 1% of the paths.
 */
function heaviestStackBelow(
  paths: StackFrame[][],
  maxRows: number
): { frames: string[]; count: number }[] {
  const rows: { frames: string[]; count: number }[] = [];
  let current = paths;
  for (let depth = 0; current.length > 0; depth++) {
    const counts = new Map<string, number>();
    for (const path of current) {
      const frame = path[depth];
      if (frame) counts.set(frame.name, (counts.get(frame.name) ?? 0) + 1);
    }
    const heaviest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!heaviest || heaviest[1] * 100 < paths.length) break;
    const [name, count] = heaviest;
    const last = rows[rows.length - 1];
    if (last && last.count === count) last.frames.push(name);
    else if (rows.length < maxRows) rows.push({ frames: [name], count });
    else break;
    current = current.filter((path) => path[depth]?.name === name);
  }
  return rows;
}

export function renderThreadBreakdownIos(
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
    lines.push(`| ${escapeMarkdownTableCell(thread)} | ${weightMs} | ${pct}% | ${samples} |`);
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
          `| ${escapeMarkdownTableCell(hotspotName(h))} | ${h.totalWeightMs} | ${h.weightPercentage}% | ${h.duringHang ? "Yes" : "No"} |`
        );
      }
    }
  }

  return lines.join("\n");
}

export function renderLeakStacksIos(
  memoryLeaks: MemoryLeak[],
  objectTypeFilter: string | undefined,
  topN: number,
  mallocStackLogging?: boolean | null,
  leaksRecorded?: boolean,
  customTemplate?: boolean | null
): string {
  // Empty because nothing was recorded, not because nothing leaked.
  if (leaksRecorded === false) return `_${LEAKS_NOT_RECORDED}_`;

  // Read from the FULL capture, never the object_type-filtered slice: the note on
  // the unattributed groups depends on whether the capture attributed any group,
  // as in renderUnattributedLeaksNote in ios-profiler/render.ts.
  const attributedCount = memoryLeaks.filter((l) => l.attributed).length;
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

  // The app's own leaks first, then those of system libraries, then the
  // unattributed ones, so a small real leak survives the top-N slice ahead of
  // larger system noise.
  const sorted = [...filtered]
    .sort((a, b) => leakRank(a) - leakRank(b) || b.totalSizeBytes - a.totalSizeBytes)
    .slice(0, topN);

  const totalBytes = sorted.reduce((s, l) => s + l.totalSizeBytes, 0);
  const totalCount = sorted.reduce((s, l) => s + l.count, 0);

  const unattributed = sorted.filter((l) => !l.attributed);

  const lines: string[] = [
    `## Memory Leaks${objectTypeFilter ? ` (filter: "${objectTypeFilter}")` : ""}`,
    "",
    `**Total:** ${formatBytes(totalBytes)} across ${totalCount} allocations`,
    "",
  ];

  if (unattributed.length > 0) {
    lines.push(
      renderUnattributedLeaksNote(
        unattributed,
        attributedCount,
        mallocStackLogging,
        customTemplate
      ),
      ""
    );
  }

  const systemLeaks = sorted.filter((l) => l.attributed && l.systemLibrary);
  if (systemLeaks.length > 0) lines.push(renderSystemLibraryLeaksNote(systemLeaks), "");

  lines.push(
    "| Object Type | Size | Count | Responsible Frame | Library |",
    "|---|---|---|---|---|"
  );

  for (const l of sorted) {
    lines.push(
      `| \`${escapeMarkdownTableCell(l.objectType)}\` | ${formatBytes(l.totalSizeBytes)} | ${l.count} | \`${escapeMarkdownTableCell(demangleSymbol(l.responsibleFrame))}\` | ${escapeMarkdownTableCell(l.responsibleLibrary) || "—"} |`
    );
  }

  return lines.join("\n");
}

async function executeIos(api: NativeProfilerSessionApi, params: z.infer<typeof zodSchema>) {
  const data = getIosParsedData(api);
  switch (params.mode) {
    case "hang_stacks": {
      if (params.hang_index == null) {
        throw new FailureError("hang_stacks mode requires the hang_index parameter.", {
          error_code: FAILURE_CODES.PROFILER_QUERY_REQUIRED_PARAM_MISSING,
          failure_stage: "profiler_stack_query_params",
          failure_area: "tool_server",
          error_kind: "validation",
        });
      }
      return renderHangStacksIos(data.cpuSamples, data.uiHangs, params.hang_index, params.top_n);
    }
    case "function_callers": {
      if (!params.function_name) {
        throw new FailureError("function_callers mode requires the function_name parameter.", {
          error_code: FAILURE_CODES.PROFILER_QUERY_REQUIRED_PARAM_MISSING,
          failure_stage: "profiler_stack_query_params",
          failure_area: "tool_server",
          error_kind: "validation",
        });
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
      // Capture mode from parsedData, frozen with the leaks it describes — the
      // live session field is re-stamped by any later recording.
      return renderLeakStacksIos(
        data.memoryLeaks,
        params.object_type,
        params.top_n,
        data.mallocStackLogging,
        data.leaksRecorded,
        data.customTemplate
      );
    default:
      throw new FailureError(`Unknown mode: ${params.mode}`, {
        error_code: FAILURE_CODES.PROFILER_QUERY_MODE_INVALID,
        failure_stage: "profiler_stack_query_mode",
        failure_area: "tool_server",
        error_kind: "validation",
      });
  }
}

async function executeAndroid(api: NativeProfilerSessionApi, params: z.infer<typeof zodSchema>) {
  if (!api.exportedFiles?.pftrace || !api.traceFile) {
    throw new FailureError(
      "No Android trace loaded. Run native-profiler-stop → native-profiler-analyze first.",
      {
        error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
        failure_stage: "profiler_stack_query_android_unloaded",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  if (params.mode === "leak_stacks") {
    return `_Memory leak detection is not yet supported on Android. Use the RSS-growth weak signal in the analyze report as a hint, or capture a heap dump manually with \`${adbCommandPrefix(process.env)}adb shell am dumpheap\`._`;
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

const zodSchema = z.object({
  device_id: metroDeviceIdParam(
    "iOS Simulator UDID<flag:macos-apps>, Mac app id</flag:macos-apps> or Android serial."
  ),
  mode: z
    .enum(["hang_stacks", "function_callers", "thread_breakdown", "leak_stacks"])
    .describe("Query mode; see Modes in the tool description."),
  hang_index: z.coerce.number().int().optional().describe("0-based index into the hang list"),
  function_name: z.string().optional().describe("Native function name"),
  thread: z
    .string()
    .optional()
    .describe(
      "Thread filter. thread_breakdown: case-insensitive substring match. " +
        'function_callers: exact raw thread name (e.g. ".blueskyweb.app"), or "main" for ' +
        "the UI thread; omit to search ALL threads (each result is tagged with its thread). " +
        "Run thread_breakdown first to see the exact raw names."
    ),
  object_type: z.string().optional().describe("Object type filter"),
  top_n: z.coerce.number().int().positive().default(15).describe("Max results to return"),
});

type Params = z.infer<typeof zodSchema>;

export const profilerStackQueryTool: ToolDefinition<Params, string> = {
  id: "profiler-stack-query",
  description: `Query native profiler trace data for iterative investigation of native performance.
Modes:
- hang_stacks: Full CPU context during a specific hang (by hang_index).
- function_callers: Who calls function_name and what it calls.
- thread_breakdown: CPU time split by thread, optionally filtered.
- leak_stacks: Memory leak details (iOS<flag:macos-apps> and Mac apps</flag:macos-apps> only), optionally filtered by object_type.
Use when drilling into native hang stacks, thread CPU breakdown, or memory leaks after native-profiler-analyze.
Returns a markdown report with native call stacks, thread weights, or leak details for the selected mode.
Fails if native-profiler-stop → native-profiler-analyze has not been run or no parsed trace data is in memory.`,
  zodSchema,
  readOnly: true,
  interaction: {
    startedMsg: ({ params }) => `Querying native stacks by ${stackQueryMode[params.mode]}`,
    completedMsg: ({ params }) => `Queried native stacks by ${stackQueryMode[params.mode]}`,
    failedMsg: ({ failureSignal }) => `Failed to query native stacks: ${failureSignal.error_code}`,
  },
  // No chromium entry: it has no native trace capture.
  capability: {
    apple: { simulator: true },
    android: { emulator: true, device: true, unknown: true },
    macos: { app: true },
  },
  // The Android branch re-queries the .pftrace, so a cold trace-processor engine
  // re-pays the full parse past the 30s MCP fetch timeout, whose abort replays
  // rather than cancels.
  longRunning: true,
  services: (params) => ({
    session: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params) {
    const api = services.session as NativeProfilerSessionApi;
    // No capture state at all means this call minted the session, so nothing is
    // known about the device. The message names no platform: classification is
    // shape-based and calls any opaque id "android" (utils/device-info.ts:52),
    // and a forwarded Metro logicalDeviceId — resolvable only while its debugger
    // connection lives — lands here routinely (#618).
    if (!api.traceFile && !api.exportedFiles && !api.parsedData) {
      throw new FailureError(
        `No native profiler capture is loaded for device \`${params.device_id}\`. Run ` +
          "native-profiler-start → native-profiler-stop → native-profiler-analyze on this device " +
          "first. (If that id came from debugger-connect, pass the id from list-devices instead — " +
          "the simulator UDID or adb serial — since profiler sessions are keyed by that one.)",
        {
          error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
          failure_stage: "profiler_stack_query_load_native_data",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    }

    if (api.platform === "android") {
      return executeAndroid(api, params);
    }
    return executeIos(api, params);
  },
};
