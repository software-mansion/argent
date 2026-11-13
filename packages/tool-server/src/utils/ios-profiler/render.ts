import { promises as fs } from "fs";
import * as path from "path";
import bytesUtil from "bytes";
import type { TraceProcessorUnavailableError } from "@argent/native-devtools-android";
import { demangleSymbol } from "../profiler-shared/demangle";
import { escapeMarkdownTableCell } from "../profiler-shared/format";
import type {
  ProfilerPayload,
  Bottleneck,
  CpuHotspot,
  UiHang,
  MemoryLeak,
  MemoryRssGrowth,
  NativeProfilerAnalyzeResult,
} from "./types";
import { summarizeHangBlocking } from "../profiler-shared/native-frame-class";

const MAX_INLINE_HOTSPOTS = 5;
const MAX_INLINE_HANGS = 3;

/** A function of a hang as the report shows it, marked when a tool's library holds it. */
function hangFunctionName(hang: UiHang, fn: string): string {
  const label = hang.toolingLabels?.[fn];
  return label ? `${demangleSymbol(fn)} (${label})` : demangleSymbol(fn);
}

/**
 * Follows a hang's duration when macOS held the app suspended during the hang,
 * time the duration leaves out. Empty otherwise.
 */
export function hangSuspendedNote(hang: UiHang): string {
  return hang.suspendedMs !== undefined && hang.suspendedMs > 0
    ? `, not counting ${hang.suspendedMs}ms when the app was suspended`
    : "";
}

/**
 * Said where an iOS capture with no Leaks table would otherwise read as "0 leaks":
 * the analyze report (with a warning not to report the app as leak-free) and
 * leak_stacks. The combined report and profiler-load print their own shorter
 * "not recorded" instead. It states the outcome, not the cause (a template without
 * the Leaks instrument, or a failed leaks export), so it stays true whichever
 * capture produced the trace.
 */
export const LEAKS_NOT_RECORDED = "No leak data was recorded, so memory leaks were not checked.";

interface RenderInput {
  payload: ProfilerPayload;
  traceFile: string | null;
  exportErrors?: Record<string, string>;
  /** Markdown warning shown in the header when the trace is stale. */
  freshnessNote?: string;
  /**
   * Markdown warning about the CPU data itself (e.g. samples with no call
   * stacks). Kept out of exportErrors because nothing errored and the
   * all-clear banner counts exportErrors entries as failed queries.
   */
  cpuDiagnostic?: string;
  /**
   * Whether the capture cold-launched the app with MallocStackLogging=1
   * (native-profiler-start's malloc_stack_logging flag). Null/undefined when
   * unknown — a session restored from disk has no capture-mode sidecar — and
   * the unattributed-leaks note then reads it as a capture without malloc stack
   * logging.
   */
  mallocStackLogging?: boolean | null;
  /**
   * Whether the recording used a template of the caller (template_path). False for the
   * bundled template, which has the Allocations instrument. Null/undefined when unknown.
   */
  customTemplate?: boolean | null;
  /**
   * xctrace: false when the trace has no leak data (no leaks export, or one with
   * no Leaks detail) or Instruments could not capture it, so the report must not
   * read as leak-free. Undefined (Android) leaves the report unchanged.
   */
  leaksRecorded?: boolean;
  /** Why no leak was recorded, said with the not-recorded note when known. */
  leaksNotRecordedCause?: string;
  /**
   * Mac apps: true when a note in freshnessNote says that the trace can miss
   * findings (the app ended during the recording, or no leak check finished), so
   * a report with no finding must not read as all clear.
   */
  mayMissFindings?: boolean;
}

interface InlineCap {
  hotspotLimit: number;
  hangLimit: number;
}

/**
 * Renders both iOS and Android payloads despite the ios-profiler/ home,
 * branching on `b.platform`/`b.type` for Android-only rows (jank reason,
 * state breakdown, RSS growth).
 */
export async function renderNativeProfilerReport(
  input: RenderInput
): Promise<NativeProfilerAnalyzeResult> {
  const {
    payload,
    traceFile,
    freshnessNote,
    cpuDiagnostic,
    mallocStackLogging,
    customTemplate,
    leaksRecorded,
    leaksNotRecordedCause,
    mayMissFindings,
  } = input;
  const exportErrors = input.exportErrors ?? {};
  const bottlenecksTotal = payload.bottlenecks.length;
  const status: "ok" | "analysis_failed" =
    Object.keys(exportErrors).length > 0 ? "analysis_failed" : "ok";

  const cpuHotspotsCount = payload.bottlenecks.filter((b) => b.type === "cpu_hotspot").length;
  const uiHangsCount = payload.bottlenecks.filter((b) => b.type === "ui_hang").length;

  const fullReport =
    bottlenecksTotal === 0
      ? renderAllClear(
          payload,
          exportErrors,
          freshnessNote,
          cpuDiagnostic,
          leaksRecorded,
          mayMissFindings,
          leaksNotRecordedCause
        )
      : renderFullReport(
          payload,
          exportErrors,
          {
            hotspotLimit: Infinity,
            hangLimit: Infinity,
          },
          freshnessNote,
          mallocStackLogging,
          cpuDiagnostic,
          leaksRecorded,
          leaksNotRecordedCause,
          customTemplate
        );

  const reportFile = traceFile ? deriveReportPath(traceFile) : null;
  const wroteFile = reportFile ? await writeReport(reportFile, fullReport) : false;

  const inlineReport =
    bottlenecksTotal === 0
      ? renderAllClear(
          payload,
          exportErrors,
          freshnessNote,
          cpuDiagnostic,
          leaksRecorded,
          mayMissFindings,
          leaksNotRecordedCause
        )
      : renderFullReport(
          payload,
          exportErrors,
          {
            hotspotLimit: MAX_INLINE_HOTSPOTS,
            hangLimit: MAX_INLINE_HANGS,
          },
          freshnessNote,
          mallocStackLogging,
          cpuDiagnostic,
          leaksRecorded,
          leaksNotRecordedCause,
          customTemplate
        );

  const shownHotspots = Math.min(MAX_INLINE_HOTSPOTS, cpuHotspotsCount);
  const shownHangs = Math.min(MAX_INLINE_HANGS, uiHangsCount);
  // Name only the categories actually shown — "top 0 hangs" reads as a report
  // artifact. Both can be 0 at once (an RSS-growth-only trace still has
  // bottlenecks), hence the fallback.
  const shownParts = [
    ...(shownHotspots > 0 ? [`top ${shownHotspots} CPU hotspots`] : []),
    ...(shownHangs > 0 ? [`top ${shownHangs} hangs`] : []),
  ];
  const shownSummary =
    shownParts.length > 0 ? `showing ${shownParts.join(" and ")} inline` : `summary inline`;
  // Point at the result field, not the host path: `reportFile` is registered
  // as an artifact the client materializes locally, so the server path would
  // dangle when the tool-server runs remotely.
  const report =
    wroteFile && reportFile
      ? inlineReport +
        `\n\n> Full report saved — ${bottlenecksTotal} bottleneck(s) total, ${shownSummary}. Use the Read tool on the \`reportFile\` path in this result to view all details.`
      : inlineReport;

  return {
    report,
    reportFile: wroteFile ? reportFile : null,
    bottlenecksTotal,
    status,
    exportErrors,
  };
}

/**
 * Shown when Android analysis cannot run because the bundled Perfetto
 * trace-processor WASM failed to load. A *top-level* report body, not a
 * "> Export warnings" line, so the recovery steps are front and centre. The
 * caller pairs it with an empty `exportErrors` and `status: "analysis_failed"`.
 */
export function renderTraceProcessorUnavailable(err: TraceProcessorUnavailableError): string {
  const lines = [
    `# Android Perfetto Analysis — Cannot Run`,
    ``,
    `> ⚠️ **The bundled Perfetto trace-processor WASM engine needed to analyze ` +
      `Android traces failed to load on this machine.**`,
    ``,
    err.message,
    ``,
    `---`,
    ``,
    `## How to fix`,
    ``,
    `The engine ships as a single \`trace_processor.wasm\` bundled inside Argent — ` +
      `there's nothing to download. A load failure almost always means the bundled ` +
      `file is missing or corrupt, so reinstall Argent:`,
    ``,
    "```bash",
    `npm install -g @swmansion/argent`,
    "```",
    ``,
    `**Air-gapped, or want to pin a known-good engine?** Point Argent at a ` +
      `\`trace_processor.wasm\` you stage yourself:`,
    ``,
    "```bash",
    `export ARGENT_TRACE_PROCESSOR_WASM=/absolute/path/to/trace_processor.wasm`,
    "```",
    ``,
    `Then re-run \`native-profiler-analyze\`.`,
  ];
  return lines.join("\n");
}

function reportTitle(payload: ProfilerPayload): string {
  const platform = payload.metadata.platform.toLowerCase();
  if (platform === "android") return "Android Perfetto Analysis";
  return platform === "macos" ? "macOS Instruments Analysis" : "iOS Instruments Analysis";
}

function renderAllClear(
  payload: ProfilerPayload,
  exportErrors?: Record<string, string>,
  freshnessNote?: string,
  cpuDiagnostic?: string,
  leaksRecorded?: boolean,
  mayMissFindings?: boolean,
  leaksNotRecordedCause?: string
): string {
  const traceName = payload.metadata.traceFile
    ? `\`${path.basename(payload.metadata.traceFile)}\``
    : "unknown";
  const lines = [
    `# ${reportTitle(payload)}`,
    ``,
    `**Trace:** ${traceName}  |  **Platform:** ${payload.metadata.platform}  |  **Analyzed:** ${payload.metadata.timestamp}`,
    ``,
  ];

  if (freshnessNote) lines.push(freshnessNote, ``);
  if (cpuDiagnostic) lines.push(`> ⚠️ **CPU sampling:** ${cpuDiagnostic}`, ``);
  if (leaksRecorded === false) lines.push(renderLeaksNotRecordedNote(leaksNotRecordedCause), ``);

  const errorLines = renderExportErrors(exportErrors);
  if (errorLines.length > 0) {
    lines.push(...errorLines, ``);
  }

  lines.push(`---`, ``);

  const failedCount = exportErrors ? Object.keys(exportErrors).length : 0;
  if (failedCount > 0) {
    // Zero bottlenecks + a failed exporter is NOT "all clear" — the analysis
    // itself could not run.
    lines.push(
      `⚠️ **Analysis failed** — ${failedCount} of 3 ${
        failedCount === 1 ? "query" : "queries"
      } errored. See the **Export warnings** block above. No findings could be produced from this trace.`
    );
  } else {
    lines.push(
      leaksRecorded === false
        ? `No CPU hotspots or UI hangs detected. Memory leaks were not checked (see above).`
        : mayMissFindings
          ? `No CPU hotspots, UI hangs, or memory issues detected, but this trace can miss them (see above).`
          : `All clear — no CPU hotspots, UI hangs, or memory issues detected.`,
      ``,
      `Consider re-profiling under heavier load or longer duration to catch issues that don't appear in short sessions.`
    );
  }
  return lines.join("\n");
}

function renderFullReport(
  payload: ProfilerPayload,
  exportErrors?: Record<string, string>,
  cap: InlineCap = { hotspotLimit: Infinity, hangLimit: Infinity },
  freshnessNote?: string,
  mallocStackLogging?: boolean | null,
  cpuDiagnostic?: string,
  leaksRecorded?: boolean,
  leaksNotRecordedCause?: string,
  customTemplate?: boolean | null
): string {
  const traceName = payload.metadata.traceFile
    ? `\`${path.basename(payload.metadata.traceFile)}\``
    : "unknown";

  const cpuHotspots = payload.bottlenecks.filter((b): b is CpuHotspot => b.type === "cpu_hotspot");
  const uiHangs = payload.bottlenecks.filter((b): b is UiHang => b.type === "ui_hang");
  const memoryLeaks = payload.bottlenecks.filter((b): b is MemoryLeak => b.type === "memory_leak");
  const rssGrowths = payload.bottlenecks.filter(
    (b): b is MemoryRssGrowth => b.type === "memory_rss_growth"
  );

  const lines: string[] = [
    `# ${reportTitle(payload)}`,
    ``,
    `**Trace:** ${traceName}  |  **Platform:** ${payload.metadata.platform}  |  **Analyzed:** ${payload.metadata.timestamp}`,
    ``,
  ];

  if (freshnessNote) lines.push(freshnessNote, ``);
  if (cpuDiagnostic) lines.push(`> ⚠️ **CPU sampling:** ${cpuDiagnostic}`, ``);
  if (leaksRecorded === false) lines.push(renderLeaksNotRecordedNote(leaksNotRecordedCause), ``);

  const errorLines = renderExportErrors(exportErrors);
  if (errorLines.length > 0) {
    lines.push(...errorLines, ``);
  }

  lines.push(`---`, ``, `## Summary`, ``, `| Category | Count | Severity |`, `|---|---|---|`);

  if (cpuHotspots.length > 0) {
    lines.push(`| CPU Hotspots | ${cpuHotspots.length} | ${severitySummary(cpuHotspots)} |`);
  }
  if (uiHangs.length > 0) {
    lines.push(`| UI Hangs | ${uiHangs.length} | ${severitySummary(uiHangs)} |`);
  }
  if (memoryLeaks.length > 0) {
    lines.push(`| Memory Leaks | ${memoryLeaks.length} | ${severitySummary(memoryLeaks)} |`);
  } else if (leaksRecorded === false) {
    lines.push(`| Memory Leaks | not recorded | — |`);
  }
  if (rssGrowths.length > 0) {
    lines.push(
      `| RSS Growth (weak signal) | ${rssGrowths.length} | ${severitySummary(rssGrowths)} |`
    );
  }

  if (cpuHotspots.length > 0) {
    lines.push(``, `---`, ``, `## CPU Hotspots`, ``);
    lines.push(
      `| # | Function | Thread | Weight (ms) | Weight % | Samples | During Hang? | Severity |`,
      `|---|---|---|---|---|---|---|---|`
    );
    cpuHotspots.forEach((b, i) => {
      const hangFlag = b.duringHang ? "Yes" : "—";
      lines.push(
        `| ${i + 1} | \`${escapeMarkdownTableCell(demangleSymbol(b.dominantFunction))}\` | ${escapeMarkdownTableCell(b.thread)} | ${b.totalWeightMs} | ${b.weightPercentage}% | ${b.sampleCount} | ${hangFlag} | ${severityEmoji(b.severity)} |`
      );
    });

    const systemFrameCount = cpuHotspots.filter((b) => b.frameClass === "system").length;
    if (systemFrameCount > 0) {
      lines.push(
        ``,
        `> **Note:** ${systemFrameCount} of these ${systemFrameCount === 1 ? "hotspots is an emulator/kernel frame" : "hotspots are emulator/kernel frames"} ` +
          `(e.g. \`goldfish_*\`, \`do_syscall_64\`, \`gup_*\`) — the QEMU GPU-transport pipe and Linux syscall paths, ` +
          `not app code. They dominate RenderThread on the emulator and do not appear on physical devices. ` +
          `Re-profile on a real device for representative app CPU numbers.`
      );
    }

    const hotspotDetailSlice = isFinite(cap.hotspotLimit)
      ? cpuHotspots.slice(0, cap.hotspotLimit)
      : cpuHotspots;
    for (const b of hotspotDetailSlice) {
      lines.push(``);
      lines.push(`### \`${demangleSymbol(b.dominantFunction)}\` (${b.thread})`);
      lines.push(``);

      if (b.topCallChains && b.topCallChains.length > 0) {
        lines.push(`**Call chains:**`);
        for (const { chain, count } of b.topCallChains) {
          lines.push(`- (${count}×) \`${chain.map(demangleSymbol).join(" > ")}\``);
        }
        lines.push(``);
      } else if (b.topCallChain.length > 0) {
        lines.push(`**Call chain:** \`${b.topCallChain.map(demangleSymbol).join(" > ")}\``);
        lines.push(``);
      }

      if (b.burstWindows && b.burstWindows.length > 1) {
        lines.push(`**Activity bursts:** ${b.burstWindows.length} clusters`);
        for (const burst of b.burstWindows) {
          const startSec = (burst.startMs / 1000).toFixed(1);
          const endSec = (burst.endMs / 1000).toFixed(1);
          lines.push(`- ${startSec}s → ${endSec}s (${burst.sampleCount} samples)`);
        }
        lines.push(``);
      } else if (b.timeRangeMs) {
        const startSec = (b.timeRangeMs.first / 1000).toFixed(1);
        const endSec = (b.timeRangeMs.last / 1000).toFixed(1);
        lines.push(`**Active range:** ${startSec}s → ${endSec}s`);
        lines.push(``);
      }
    }
    if (isFinite(cap.hotspotLimit) && cpuHotspots.length > cap.hotspotLimit) {
      lines.push(
        `> ... and ${cpuHotspots.length - cap.hotspotLimit} more hotspot(s). See full report for details.`,
        ``
      );
    }
  }

  if (uiHangs.length > 0) {
    lines.push(``, `---`, ``, `## UI Hangs`, ``);
    const headerHasJank = uiHangs.some((h) => h.jankReason);
    if (headerHasJank) {
      lines.push(
        `| # | Type | Reason | Start | Duration | Severity |`,
        `|---|---|---|---|---|---|`
      );
      uiHangs.forEach((b, i) => {
        lines.push(
          `| ${i + 1} | ${b.hangType} | ${b.jankReason ?? "—"} | ${b.startTimeFormatted} | ${b.durationMs}ms${hangSuspendedNote(b)} | ${severityEmoji(b.severity)} |`
        );
      });
    } else {
      lines.push(`| # | Type | Start | Duration | Severity |`, `|---|---|---|---|---|`);
      uiHangs.forEach((b, i) => {
        lines.push(
          `| ${i + 1} | ${b.hangType} | ${b.startTimeFormatted} | ${b.durationMs}ms${hangSuspendedNote(b)} | ${severityEmoji(b.severity)} |`
        );
      });
    }

    const hangDetailSlice = isFinite(cap.hangLimit) ? uiHangs.slice(0, cap.hangLimit) : uiHangs;
    for (const hang of hangDetailSlice) {
      const header =
        `**${hang.hangType} at ${hang.startTimeFormatted} (${hang.durationMs}ms${hangSuspendedNote(hang)})**` +
        (hang.jankReason ? ` — reason: \`${hang.jankReason}\`` : "") +
        (hang.gcOverlapMs && hang.gcOverlapMs > 0
          ? ` — +${Math.round(hang.gcOverlapMs)}ms in GC`
          : "");

      if (hang.platform === "android" && hang.stateBreakdown && hang.stateBreakdown.length > 0) {
        lines.push(``);
        lines.push(`${header} — main-thread state breakdown:`);
        lines.push(``, `| State | Blocked on | Duration |`, `|---|---|---|`);
        for (const entry of hang.stateBreakdown) {
          lines.push(
            `| ${entry.state} | ${entry.blockedFunction ? `\`${entry.blockedFunction}\`` : "—"} | ${entry.durationMs}ms |`
          );
        }
        if (hang.appCallChains.length > 0) {
          lines.push(``);
          lines.push(`App call chains during this hang:`);
          hang.appCallChains.forEach((entry, i) => {
            lines.push(
              `${i + 1}. \`${entry.chain.map((fn) => hangFunctionName(hang, fn)).join(" > ")}\` (${entry.sampleCount} samples)`
            );
          });
        }
      } else if (hang.appCallChains.length > 0) {
        lines.push(``);
        lines.push(`${header} — app call chains during this hang:`);
        hang.appCallChains.forEach((entry, i) => {
          lines.push(
            `${i + 1}. \`${entry.chain.map((fn) => hangFunctionName(hang, fn)).join(" > ")}\` (${entry.sampleCount} samples)`
          );
        });
      } else if (hang.suspectedFunctions.length > 0) {
        lines.push(``);
        lines.push(`${header} — during this hang, the most active functions were:`);
        for (const fn of hang.suspectedFunctions) {
          lines.push(`- \`${hangFunctionName(hang, fn)}\``);
        }
      } else {
        lines.push(``);
        lines.push(header);
      }
    }
    if (isFinite(cap.hangLimit) && uiHangs.length > cap.hangLimit) {
      lines.push(
        ``,
        `> ... and ${uiHangs.length - cap.hangLimit} more hang(s). See full report for details.`
      );
    }
  }

  // Attributed leaks (a resolved responsible frame) are shown in full;
  // unattributed ones collapse into one low-confidence line so the noise can't
  // masquerade as a wall of RED findings. See isLeakAttributed in
  // pipeline/01-correlate.ts.
  if (memoryLeaks.length > 0) {
    const attributedLeaks = memoryLeaks.filter((b) => b.attributed);
    const unattributedLeaks = memoryLeaks.filter((b) => !b.attributed);

    lines.push(``, `---`, ``, `## Memory Leaks`, ``);

    if (attributedLeaks.length > 0) {
      lines.push(
        `| # | Object Type | Count | Total Size | Responsible Frame | Library | Severity |`,
        `|---|---|---|---|---|---|---|`
      );
      attributedLeaks.forEach((b, i) => {
        lines.push(
          `| ${i + 1} | \`${escapeMarkdownTableCell(b.objectType)}\` | ${b.count} | ${formatBytes(b.totalSizeBytes)} | \`${escapeMarkdownTableCell(demangleSymbol(b.responsibleFrame))}\` | ${escapeMarkdownTableCell(b.responsibleLibrary) || "—"} | ${severityEmoji(b.severity)} |`
        );
      });
      const systemLeaks = attributedLeaks.filter((b) => b.systemLibrary);
      if (systemLeaks.length > 0) lines.push(``, renderSystemLibraryLeaksNote(systemLeaks));
    } else {
      lines.push(`_No attributed leaks — nothing with a resolved responsible frame._`);
    }

    if (unattributedLeaks.length > 0) {
      lines.push(
        ``,
        renderUnattributedLeaksNote(
          unattributedLeaks,
          attributedLeaks.length,
          mallocStackLogging,
          customTemplate
        )
      );
    }
  }

  if (rssGrowths.length > 0) {
    lines.push(``, `---`, ``, `## RSS Growth — Weak Signal`, ``);
    lines.push(
      `> **Manual confirmation needed.** Resident-set size grew during the recording, ` +
        `but RSS growth is a weak proxy — it can be normal warm-up behaviour (JIT compilation, ` +
        `texture caches). Real Android leak detection lands in a later phase via heap-dump analysis.`,
      ``
    );
    lines.push(`| Start (MB) | Peak (MB) | Growth (MB) | Severity |`, `|---|---|---|---|`);
    for (const g of rssGrowths) {
      lines.push(
        `| ${g.startMb.toFixed(1)} | ${g.peakMb.toFixed(1)} | ${g.growthMb.toFixed(1)} | ${severityEmoji(g.severity)} |`
      );
    }
  }

  lines.push(``, `---`, ``, `## Suggested Improvements`, ``);

  if (cpuHotspots.length > 0) {
    lines.push(`### CPU Hotspots`, ``);
    for (const b of cpuHotspots) {
      const advice =
        b.frameClass === "system"
          ? `Emulator/kernel overhead (GPU-transport pipe or syscall), not app code — it does not appear on a physical device, so it is not directly actionable. Re-profile on a real device to see the app's own CPU cost.`
          : `High CPU in this function — inspect what calls it with \`function_callers\`, then move the heavy work off the main thread or memoize/throttle it.`;
      lines.push(
        `- ${severityEmoji(b.severity)} \`${demangleSymbol(b.dominantFunction)}\` on ${b.thread} (${b.weightPercentage}%): ${advice}`
      );
    }
    lines.push(``);
  }

  if (uiHangs.length > 0) {
    lines.push(`### UI Hangs`, ``);
    for (const b of uiHangs) {
      const funcNote =
        b.suspectedFunctions.length > 0
          ? ` Likely caused by: \`${hangFunctionName(b, b.suspectedFunctions[0]!)}\`.`
          : "";
      const reasonNote = b.jankReason ? ` Reason: \`${b.jankReason}\`.` : "";
      lines.push(
        `- ${severityEmoji(b.severity)} ${b.hangType} at ${b.startTimeFormatted} (${b.durationMs}ms${hangSuspendedNote(b)}): ${hangCoreAdvice(b)}${reasonNote}${funcNote}`
      );
    }
    lines.push(``);
  }

  const appLeaks = memoryLeaks.filter((b) => b.attributed && !b.systemLibrary);
  if (appLeaks.length > 0) {
    lines.push(`### Memory Leaks`, ``);
    for (const b of appLeaks) {
      lines.push(
        `- ${severityEmoji(b.severity)} \`${b.objectType}\` x${b.count} (${formatBytes(b.totalSizeBytes)}) via \`${demangleSymbol(b.responsibleFrame)}\`: Check for retain cycles or strong delegate references.`
      );
    }
    lines.push(``);
  }

  lines.push(`---`, ``, `## Next Steps`, ``);
  lines.push(`Ask the user which path to take:`, ``);
  lines.push(
    `1. **Investigate further** — use \`profiler-stack-query\` to drill into specific findings:`
  );
  if (uiHangs.length > 0) {
    lines.push(
      `   - mode=\`hang_stacks\` hang_index=0 — main-thread state + any on-CPU stacks for the worst hang`
    );
  }
  if (cpuHotspots.length > 0) {
    // Prefer the top *app* hotspot: on Android the leading hotspot is often a
    // `system` (emulator/kernel) frame the report already flags as not
    // actionable. iOS hotspots have no `frameClass`, so this picks their first.
    const callerHotspot = cpuHotspots.find((b) => b.frameClass !== "system");
    if (callerHotspot) {
      // Keep the RAW (possibly mangled) name: function_callers matches against
      // raw frame names, so a demangled one would find nothing.
      lines.push(
        `   - mode=\`function_callers\` function_name=\`${callerHotspot.dominantFunction}\` — who calls this hot function`
      );
    }
    lines.push(`   - mode=\`thread_breakdown\` — CPU distribution across threads`);
  }
  const topAttributedLeak = memoryLeaks.find((b) => b.attributed);
  if (topAttributedLeak) {
    lines.push(
      `   - mode=\`leak_stacks\` object_type=\`${topAttributedLeak.objectType}\` — detailed leak analysis`
    );
  }
  lines.push(
    `2. **Implement fixes** — apply changes to address the findings above, then re-profile to measure improvement.`
  );
  lines.push(`3. **Done for now** — save the report for reference.`);

  return lines.join("\n");
}

/** The note on the leaks whose responsible frame is in a system library. */
export function renderSystemLibraryLeaksNote(systemLeaks: MemoryLeak[]): string {
  const objs = systemLeaks.reduce((s, b) => s + b.count, 0);
  const libraries = [...new Set(systemLeaks.map((b) => b.responsibleLibrary))]
    .map((name) => `\`${name}\``)
    .join(", ");
  return (
    `> ${severityEmoji("YELLOW")} **${systemLeaks.length} leak group(s) from system libraries** ` +
    `(${objs} object(s); ${libraries}): the responsible frame is in a library of the OS, not in the ` +
    `app's code. Most likely the OS leaks these objects by itself, so they are not confirmed app leaks.`
  );
}

/**
 * Why a leak has no allocation backtrace when the capture did not run with malloc stack
 * logging (or its mode is unknown), on a Mac app and on an iOS simulator. Without it, an
 * iOS simulator app under `xctrace --attach` (Xcode 27.2, iOS 27.0) had a responsible
 * frame for the objects that it leaked 1 s after the start, as a Mac app has.
 */
export const UNATTRIBUTED_WITHOUT_MALLOC_LOGGING =
  "Without malloc stack logging, Instruments records an allocation backtrace only for an " +
  "object allocated after the start of the recording. These groups have none, so they are " +
  "most likely older objects or benign system allocations, not confirmed app leaks. To " +
  "attribute them, record again with `malloc_stack_logging: true`.";

/** Why no leak has a responsible frame when each names `(null)` (see isLeakAttributed). */
const NO_ALLOCATIONS_LEAKS =
  "The template of this recording has no Allocations instrument, so Instruments gave no leak a " +
  "responsible frame, also not a leak of the app's code. To attribute leaks, record again " +
  "without `template_path`: the bundled Argent template has the Allocations instrument.";

/**
 * True when each of these leaks names `(null)` as its frame. A template with Leaks but no
 * Allocations gives `(null)` to every leak, so only with no attributed leak does it mean that.
 */
function leaksWithoutAllocations(leaks: MemoryLeak[]): boolean {
  return leaks.length > 0 && leaks.every((b) => b.responsibleFrame.trim() === "(null)");
}

function renderLeaksNotRecordedNote(cause?: string): string {
  return (
    `> ⚠️ **Memory leaks:** ${LEAKS_NOT_RECORDED}${cause ? ` ${cause}` : ""} ` +
    `Do not report the app as leak-free.`
  );
}

/**
 * The single low-confidence caveat line for unattributed leaks, shared with the
 * combined React × native report and leak_stacks so the wording can't diverge.
 *
 * `mallocStackLogging` is the capture mode when known (stamped at stop, frozen
 * into parsedData); null/undefined when unknown. Only explicit `true` names the
 * malloc capture. Attributed leaks do not prove malloc stack logging: without it,
 * Instruments still records a backtrace for each object allocated after the start,
 * on a Mac app and on an iOS simulator.
 *
 * `customTemplate` is whether the recording used a template of the caller; null/undefined
 * when unknown. Only such a template can lack the Allocations instrument.
 */
export function renderUnattributedLeaksNote(
  unattributedLeaks: MemoryLeak[],
  attributedCount: number,
  mallocStackLogging?: boolean | null,
  customTemplate?: boolean | null
): string {
  const objs = unattributedLeaks.reduce((s, b) => s + b.count, 0);
  const bytes = unattributedLeaks.reduce((s, b) => s + b.totalSizeBytes, 0);
  const nullFrames = leaksWithoutAllocations(unattributedLeaks);
  const frame = nullFrames ? "`(null)`" : "`<Call stack limit reached>`";
  // The bundled template has the Allocations instrument.
  if (nullFrames && attributedCount === 0 && customTemplate !== false) {
    return (
      `> ${severityEmoji("YELLOW")} **${unattributedLeaks.length} unattributed leak group(s)** ` +
      `(${objs} object(s), ${formatBytes(bytes)}): responsible frame \`(null)\`, no library. ` +
      NO_ALLOCATIONS_LEAKS
    );
  }
  // Without malloc stack logging, a Mac app and an iOS simulator app still get a backtrace
  // for an object allocated after the start, so no capture has "no malloc-stack history".
  const hint =
    mallocStackLogging !== true
      ? UNATTRIBUTED_WITHOUT_MALLOC_LOGGING
      : attributedCount > 0
        ? `Some leaks here were attributed, and malloc stack logging was active, so these ` +
          `remaining groups carry no allocation backtrace for another reason (freed-region ` +
          `reuse, truncated stack logs, or allocations outside the instrumented malloc zones). ` +
          `They are most likely benign system allocations rather than confirmed app leaks.`
        : `This capture ran with malloc stack logging enabled, yet none of these leaks carry an allocation ` +
          `backtrace — the allocator recorded no usable stack for them (freed-region reuse, truncated stack ` +
          `logs, or allocations outside the instrumented malloc zones). Most likely benign system allocations ` +
          `rather than confirmed app leaks; re-running with malloc stack logging again is unlikely to attribute them.`;
  return (
    `> ${severityEmoji("YELLOW")} **${unattributedLeaks.length} unattributed leak group(s)** ` +
    `(${objs} object(s), ${formatBytes(bytes)}): responsible frame ${frame}, no library. ${hint}`
  );
}

function renderExportErrors(exportErrors?: Record<string, string>): string[] {
  if (!exportErrors || Object.keys(exportErrors).length === 0) return [];
  const lines: string[] = [`> **Export warnings:**`];
  for (const [key, msg] of Object.entries(exportErrors)) {
    lines.push(`> - **${key}**: ${msg}`);
  }
  return lines;
}

/**
 * The advice must match the Android main-thread state breakdown: "move heavy
 * work off the main thread" is misleading when the thread was asleep waiting on
 * the GPU. iOS hangs carry no breakdown and get the generic line.
 */
function hangCoreAdvice(hang: UiHang): string {
  const blocking = summarizeHangBlocking(hang.stateBreakdown);
  if (!blocking) {
    return "Main thread stalled past the frame budget — move heavy work off the main thread.";
  }
  switch (blocking.kind) {
    case "blocked":
      return (
        `Main thread was off-CPU (state \`${blocking.dominantState}\`) for most of the hang — it was *waiting*, ` +
        `not doing CPU work. Investigate what it is blocked on (GPU/vsync, a lock, binder IPC, or I/O) via ` +
        "`hang_stacks`, rather than moving work off-thread."
      );
    case "runnable":
      return (
        `Main thread was runnable but not scheduled (state \`${blocking.dominantState}\`) for most of the hang — ` +
        `ready to run but starved of CPU. Look for other busy threads or background work contending for cores.`
      );
    case "executing":
      return (
        "Main thread was executing (on-CPU) for most of the hang — genuine main-thread CPU work. " +
        "Move heavy work off the main thread or reduce its cost."
      );
  }
}

function severityEmoji(severity: string): string {
  switch (severity) {
    case "RED":
      return "🔴";
    case "YELLOW":
      return "🟡";
    default:
      return "⚪";
  }
}

function severitySummary(bottlenecks: Bottleneck[]): string {
  const red = bottlenecks.filter((b) => b.severity === "RED").length;
  const yellow = bottlenecks.filter((b) => b.severity === "YELLOW").length;
  const parts: string[] = [];
  if (red > 0) parts.push(`🔴 ${red}`);
  if (yellow > 0) parts.push(`🟡 ${yellow}`);
  return parts.join("  ");
}

// `bytes` picks the unit, so leak totals above 1 GB render as `2.1 GB` rather
// than four digits of MB.
function formatBytes(sizeBytes: number): string {
  return bytesUtil(sizeBytes, { decimalPlaces: 1, unitSeparator: " " }) ?? `${sizeBytes} B`;
}

function deriveReportPath(traceFile: string): string {
  const dir = path.dirname(traceFile);
  const ext = path.extname(traceFile);
  const baseName = path.basename(traceFile, ext);
  return path.join(dir, `${baseName}-report.md`);
}

async function writeReport(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, "utf8");
    return true;
  } catch {
    // non-fatal — report is still returned inline
    return false;
  }
}
