import { promises as fs } from "fs";
import * as path from "path";
import type { TraceProcessorUnavailableError } from "@argent/native-devtools-android";
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

interface RenderInput {
  payload: ProfilerPayload;
  traceFile: string | null;
  exportErrors?: Record<string, string>;
}

interface InlineCap {
  hotspotLimit: number;
  hangLimit: number;
}

/**
 * Render a native profiler analysis report for iOS or Android payloads —
 * bottleneck rows are platform-agnostic, branching on `b.platform`/`b.type`
 * for Android-specific row text (jank reason, state breakdown, RSS growth).
 */
export async function renderNativeProfilerReport(
  input: RenderInput
): Promise<NativeProfilerAnalyzeResult> {
  const { payload, traceFile } = input;
  const exportErrors = input.exportErrors ?? {};
  const bottlenecksTotal = payload.bottlenecks.length;
  const status: "ok" | "analysis_failed" =
    Object.keys(exportErrors).length > 0 ? "analysis_failed" : "ok";

  const cpuHotspotsCount = payload.bottlenecks.filter((b) => b.type === "cpu_hotspot").length;
  const uiHangsCount = payload.bottlenecks.filter((b) => b.type === "ui_hang").length;

  const fullReport =
    bottlenecksTotal === 0
      ? renderAllClear(payload, exportErrors)
      : renderFullReport(payload, exportErrors, {
          hotspotLimit: Infinity,
          hangLimit: Infinity,
        });

  const reportFile = traceFile ? deriveReportPath(traceFile) : null;
  const wroteFile = reportFile ? await writeReport(reportFile, fullReport) : false;

  const inlineReport =
    bottlenecksTotal === 0
      ? renderAllClear(payload, exportErrors)
      : renderFullReport(payload, exportErrors, {
          hotspotLimit: MAX_INLINE_HOTSPOTS,
          hangLimit: MAX_INLINE_HANGS,
        });

  const shownHotspots = Math.min(MAX_INLINE_HOTSPOTS, cpuHotspotsCount);
  const shownHangs = Math.min(MAX_INLINE_HANGS, uiHangsCount);
  // Reference the result field rather than embedding the host path: the
  // client materializes `reportFile` to a path on ITS machine, and the raw
  // server path would dangle when the tool-server runs remotely.
  const report =
    wroteFile && reportFile
      ? inlineReport +
        `\n\n> Full report saved — ${bottlenecksTotal} bottleneck(s) total, showing top ${shownHotspots} CPU hotspots and top ${shownHangs} hangs inline. Use the Read tool on the \`reportFile\` path in this result to view all details.`
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
 * Render the prominent, actionable banner shown when Android analysis cannot run
 * because the bundled Perfetto trace-processor WASM engine failed to load. The
 * engine ships as a single committed `.wasm` (no per-platform binary, no
 * download), so this is rare — a corrupt/missing vendored asset, or a bad
 * `ARGENT_TRACE_PROCESSOR_WASM` override. This is a *top-level* report body (not
 * a "> Export warnings" line) so the user/agent sees the recovery steps front
 * and centre. The caller pairs this with an empty `exportErrors` and
 * `status: "analysis_failed"`.
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

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

function reportTitle(payload: ProfilerPayload): string {
  return payload.metadata.platform.toLowerCase() === "android"
    ? "Android Perfetto Analysis"
    : "iOS Instruments Analysis";
}

function renderAllClear(payload: ProfilerPayload, exportErrors?: Record<string, string>): string {
  const traceName = payload.metadata.traceFile
    ? `\`${path.basename(payload.metadata.traceFile)}\``
    : "unknown";
  const lines = [
    `# ${reportTitle(payload)}`,
    ``,
    `**Trace:** ${traceName}  |  **Platform:** ${payload.metadata.platform}  |  **Analyzed:** ${payload.metadata.timestamp}`,
    ``,
  ];

  const errorLines = renderExportErrors(exportErrors);
  if (errorLines.length > 0) {
    lines.push(...errorLines, ``);
  }

  lines.push(`---`, ``);

  const failedCount = exportErrors ? Object.keys(exportErrors).length : 0;
  if (failedCount > 0) {
    // Zero bottlenecks + at least one failed exporter is NOT "all clear" —
    // the analysis itself could not run. Replace the misleading sentence
    // with a banner that points back at the Export warnings block above.
    lines.push(
      `⚠️ **Analysis failed** — ${failedCount} of 3 ${
        failedCount === 1 ? "query" : "queries"
      } errored. See the **Export warnings** block above. No findings could be produced from this trace.`
    );
  } else {
    lines.push(
      `All clear — no CPU hotspots, UI hangs, or memory issues detected.`,
      ``,
      `Consider re-profiling under heavier load or longer duration to catch issues that don't appear in short sessions.`
    );
  }
  return lines.join("\n");
}

function renderFullReport(
  payload: ProfilerPayload,
  exportErrors?: Record<string, string>,
  cap: InlineCap = { hotspotLimit: Infinity, hangLimit: Infinity }
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
  }
  if (rssGrowths.length > 0) {
    lines.push(
      `| RSS Growth (weak signal) | ${rssGrowths.length} | ${severitySummary(rssGrowths)} |`
    );
  }

  // CPU Hotspots section
  if (cpuHotspots.length > 0) {
    lines.push(``, `---`, ``, `## CPU Hotspots`, ``);
    lines.push(
      `| # | Function | Thread | Weight (ms) | Weight % | Samples | During Hang? | Severity |`,
      `|---|---|---|---|---|---|---|---|`
    );
    cpuHotspots.forEach((b, i) => {
      const hangFlag = b.duringHang ? "Yes" : "—";
      lines.push(
        `| ${i + 1} | \`${b.dominantFunction}\` | ${b.thread} | ${b.totalWeightMs} | ${b.weightPercentage}% | ${b.sampleCount} | ${hangFlag} | ${severityEmoji(b.severity)} |`
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
      lines.push(`### \`${b.dominantFunction}\` (${b.thread})`);
      lines.push(``);

      if (b.topCallChains && b.topCallChains.length > 0) {
        lines.push(`**Call chains:**`);
        for (const { chain, count } of b.topCallChains) {
          lines.push(`- (${count}×) \`${chain.join(" > ")}\``);
        }
        lines.push(``);
      } else if (b.topCallChain.length > 0) {
        lines.push(`**Call chain:** \`${b.topCallChain.join(" > ")}\``);
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

  // UI Hangs section
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
          `| ${i + 1} | ${b.hangType} | ${b.jankReason ?? "—"} | ${b.startTimeFormatted} | ${b.durationMs}ms | ${severityEmoji(b.severity)} |`
        );
      });
    } else {
      lines.push(`| # | Type | Start | Duration | Severity |`, `|---|---|---|---|---|`);
      uiHangs.forEach((b, i) => {
        lines.push(
          `| ${i + 1} | ${b.hangType} | ${b.startTimeFormatted} | ${b.durationMs}ms | ${severityEmoji(b.severity)} |`
        );
      });
    }

    const hangDetailSlice = isFinite(cap.hangLimit) ? uiHangs.slice(0, cap.hangLimit) : uiHangs;
    for (const hang of hangDetailSlice) {
      const header =
        `**${hang.hangType} at ${hang.startTimeFormatted} (${hang.durationMs}ms)**` +
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
            lines.push(`${i + 1}. \`${entry.chain.join(" > ")}\` (${entry.sampleCount} samples)`);
          });
        }
      } else if (hang.appCallChains.length > 0) {
        lines.push(``);
        lines.push(`${header} — app call chains during this hang:`);
        hang.appCallChains.forEach((entry, i) => {
          lines.push(`${i + 1}. \`${entry.chain.join(" > ")}\` (${entry.sampleCount} samples)`);
        });
      } else if (hang.suspectedFunctions.length > 0) {
        lines.push(``);
        lines.push(`${header} — during this hang, the most active functions were:`);
        for (const fn of hang.suspectedFunctions) {
          lines.push(`- \`${fn}\``);
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

  // Memory Leaks section (iOS only in v1)
  if (memoryLeaks.length > 0) {
    lines.push(``, `---`, ``, `## Memory Leaks`, ``);
    lines.push(
      `| # | Object Type | Count | Total Size | Responsible Frame | Library | Severity |`,
      `|---|---|---|---|---|---|---|`
    );
    memoryLeaks.forEach((b, i) => {
      lines.push(
        `| ${i + 1} | \`${b.objectType}\` | ${b.count} | ${formatBytes(b.totalSizeBytes)} | \`${b.responsibleFrame}\` | ${b.responsibleLibrary || "—"} | ${severityEmoji(b.severity)} |`
      );
    });
  }

  // RSS Growth section (Android-only weak signal)
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

  // Suggested Improvements
  lines.push(``, `---`, ``, `## Suggested Improvements`, ``);

  if (cpuHotspots.length > 0) {
    lines.push(`### CPU Hotspots`, ``);
    for (const b of cpuHotspots) {
      const advice =
        b.frameClass === "system"
          ? `Emulator/kernel overhead (GPU-transport pipe or syscall), not app code — it does not appear on a physical device, so it is not directly actionable. Re-profile on a real device to see the app's own CPU cost.`
          : `High CPU in this function — inspect what calls it with \`function_callers\`, then move the heavy work off the main thread or memoize/throttle it.`;
      lines.push(
        `- ${severityEmoji(b.severity)} \`${b.dominantFunction}\` on ${b.thread} (${b.weightPercentage}%): ${advice}`
      );
    }
    lines.push(``);
  }

  if (uiHangs.length > 0) {
    lines.push(`### UI Hangs`, ``);
    for (const b of uiHangs) {
      const funcNote =
        b.suspectedFunctions.length > 0 ? ` Likely caused by: \`${b.suspectedFunctions[0]}\`.` : "";
      const reasonNote = b.jankReason ? ` Reason: \`${b.jankReason}\`.` : "";
      lines.push(
        `- ${severityEmoji(b.severity)} ${b.hangType} at ${b.startTimeFormatted} (${b.durationMs}ms): ${hangCoreAdvice(b)}${reasonNote}${funcNote}`
      );
    }
    lines.push(``);
  }

  if (memoryLeaks.length > 0) {
    lines.push(`### Memory Leaks`, ``);
    for (const b of memoryLeaks) {
      lines.push(
        `- ${severityEmoji(b.severity)} \`${b.objectType}\` x${b.count} (${formatBytes(b.totalSizeBytes)}) via \`${b.responsibleFrame}\`: Check for retain cycles or strong delegate references.`
      );
    }
    lines.push(``);
  }

  // Next steps guidance for the agent
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
    // Prefer the top *app* hotspot for the callers suggestion: on Android the
    // leading hotspot is often a `system` (emulator/kernel) frame, which the
    // CPU Hotspots note and Suggested Improvements already flag as not directly
    // actionable — suggesting `function_callers` on it would contradict that.
    // iOS hotspots have no `frameClass` (undefined ≠ "system"), so they keep
    // using cpuHotspots[0] unchanged.
    const callerHotspot = cpuHotspots.find((b) => b.frameClass !== "system");
    if (callerHotspot) {
      lines.push(
        `   - mode=\`function_callers\` function_name=\`${callerHotspot.dominantFunction}\` — who calls this hot function`
      );
    }
    lines.push(`   - mode=\`thread_breakdown\` — CPU distribution across threads`);
  }
  if (memoryLeaks.length > 0) {
    const topLeak = memoryLeaks.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)[0]!;
    lines.push(
      `   - mode=\`leak_stacks\` object_type=\`${topLeak.objectType}\` — detailed leak analysis`
    );
  }
  lines.push(
    `2. **Implement fixes** — apply changes to address the findings above, then re-profile to measure improvement.`
  );
  lines.push(`3. **Done for now** — save the report for reference.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderExportErrors(exportErrors?: Record<string, string>): string[] {
  if (!exportErrors || Object.keys(exportErrors).length === 0) return [];
  const lines: string[] = [`> **Export warnings:**`];
  for (const [key, msg] of Object.entries(exportErrors)) {
    lines.push(`> - **${key}**: ${msg}`);
  }
  return lines;
}

/**
 * Pick the core remediation sentence for a UI hang. On Android the main-thread
 * state breakdown tells us whether the stall was CPU-bound work or a wait, so
 * the advice must match: telling a developer to "move heavy work off the main
 * thread" when the thread was asleep waiting on the GPU is actively misleading.
 * iOS hangs carry no state breakdown, so they fall through to the generic line.
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

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
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
