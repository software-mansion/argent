import { promises as fs } from "fs";
import * as path from "path";
import type {
  ProfilerPayload,
  Bottleneck,
  CpuHotspot,
  UiHang,
  MemoryLeak,
  IosInstrumentsAnalyzeResult,
} from "./types";

interface RenderInput {
  payload: ProfilerPayload;
  traceFile: string | null;
  exportErrors?: Record<string, string>;
}

export async function renderIosInstrumentsReport(
  input: RenderInput,
): Promise<IosInstrumentsAnalyzeResult> {
  const { payload, traceFile } = input;
  const bottlenecksTotal = payload.bottlenecks.length;

  const report =
    bottlenecksTotal === 0
      ? renderAllClear(payload, input.exportErrors)
      : renderFullReport(payload, input.exportErrors);

  const reportFile = traceFile ? deriveReportPath(traceFile) : null;
  if (reportFile) {
    await writeReport(reportFile, report);
  }

  return { report, reportFile, bottlenecksTotal };
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

function renderAllClear(
  payload: ProfilerPayload,
  exportErrors?: Record<string, string>,
): string {
  const traceName = payload.metadata.traceFile
    ? `\`${path.basename(payload.metadata.traceFile)}\``
    : "unknown";
  const lines = [
    `# iOS Instruments Analysis`,
    ``,
    `**Trace:** ${traceName}  |  **Platform:** ${payload.metadata.platform}  |  **Analyzed:** ${payload.metadata.timestamp}`,
    ``,
  ];

  const errorLines = renderExportErrors(exportErrors);
  if (errorLines.length > 0) {
    lines.push(...errorLines, ``);
  }

  lines.push(
    `---`,
    ``,
    `All clear — no CPU hotspots, UI hangs, or memory leaks detected.`,
    ``,
    `Consider re-profiling under heavier load or longer duration to catch issues that don't appear in short sessions.`,
  );
  return lines.join("\n");
}

function renderFullReport(
  payload: ProfilerPayload,
  exportErrors?: Record<string, string>,
): string {
  const traceName = payload.metadata.traceFile
    ? `\`${path.basename(payload.metadata.traceFile)}\``
    : "unknown";

  const cpuHotspots = payload.bottlenecks.filter(
    (b): b is CpuHotspot => b.type === "ios_cpu_hotspot",
  );
  const uiHangs = payload.bottlenecks.filter(
    (b): b is UiHang => b.type === "ios_ui_hang",
  );
  const memoryLeaks = payload.bottlenecks.filter(
    (b): b is MemoryLeak => b.type === "ios_memory_leak",
  );

  const lines: string[] = [
    `# iOS Instruments Analysis`,
    ``,
    `**Trace:** ${traceName}  |  **Platform:** ${payload.metadata.platform}  |  **Analyzed:** ${payload.metadata.timestamp}`,
    ``,
  ];

  const errorLines = renderExportErrors(exportErrors);
  if (errorLines.length > 0) {
    lines.push(...errorLines, ``);
  }

  lines.push(
    `---`,
    ``,
    `## Summary`,
    ``,
    `| Category | Count | Severity |`,
    `|---|---|---|`,
  );

  if (cpuHotspots.length > 0) {
    lines.push(
      `| CPU Hotspots | ${cpuHotspots.length} | ${severitySummary(cpuHotspots)} |`,
    );
  }
  if (uiHangs.length > 0) {
    lines.push(
      `| UI Hangs | ${uiHangs.length} | ${severitySummary(uiHangs)} |`,
    );
  }
  if (memoryLeaks.length > 0) {
    lines.push(
      `| Memory Leaks | ${memoryLeaks.length} | ${severitySummary(memoryLeaks)} |`,
    );
  }

  // CPU Hotspots section
  if (cpuHotspots.length > 0) {
    lines.push(``, `---`, ``, `## CPU Hotspots`, ``);
    lines.push(
      `| # | Function | Thread | Weight (ms) | Weight % | Samples | During Hang? | Severity |`,
      `|---|---|---|---|---|---|---|---|`,
    );
    cpuHotspots.forEach((b, i) => {
      const hangFlag = b.duringHang ? "Yes" : "—";
      lines.push(
        `| ${i + 1} | \`${b.dominantFunction}\` | ${b.thread} | ${b.totalWeightMs} | ${b.weightPercentage}% | ${b.sampleCount} | ${hangFlag} | ${severityEmoji(b.severity)} |`,
      );
    });

    // Deep detail per hotspot
    for (const b of cpuHotspots) {
      lines.push(``);
      lines.push(`### \`${b.dominantFunction}\` (${b.thread})`);
      lines.push(``);

      // Top call chains
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

      // Burst windows
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
  }

  // UI Hangs section
  if (uiHangs.length > 0) {
    lines.push(``, `---`, ``, `## UI Hangs`, ``);
    lines.push(
      `| # | Type | Start | Duration | Severity |`,
      `|---|---|---|---|---|`,
    );
    uiHangs.forEach((b, i) => {
      lines.push(
        `| ${i + 1} | ${b.hangType} | ${b.startTimeFormatted} | ${b.durationMs}ms | ${severityEmoji(b.severity)} |`,
      );
    });
    // Show correlated call chains for each hang
    for (const hang of uiHangs) {
      if (hang.appCallChains.length > 0) {
        lines.push(``);
        lines.push(
          `**${hang.hangType} at ${hang.startTimeFormatted} (${hang.durationMs}ms)** — app call chains during this hang:`,
        );
        hang.appCallChains.forEach((entry, i) => {
          lines.push(
            `${i + 1}. \`${entry.chain.join(" > ")}\` (${entry.sampleCount} samples)`,
          );
        });
      } else if (hang.suspectedFunctions.length > 0) {
        lines.push(``);
        lines.push(
          `**${hang.hangType} at ${hang.startTimeFormatted} (${hang.durationMs}ms)** — during this hang, the most active functions were:`,
        );
        for (const fn of hang.suspectedFunctions) {
          lines.push(`- \`${fn}\``);
        }
      }
    }
  }

  // Memory Leaks section
  if (memoryLeaks.length > 0) {
    lines.push(``, `---`, ``, `## Memory Leaks`, ``);
    lines.push(
      `| # | Object Type | Count | Total Size | Responsible Frame | Library | Severity |`,
      `|---|---|---|---|---|---|---|`,
    );
    memoryLeaks.forEach((b, i) => {
      lines.push(
        `| ${i + 1} | \`${b.objectType}\` | ${b.count} | ${formatBytes(b.totalSizeBytes)} | \`${b.responsibleFrame}\` | ${b.responsibleLibrary || "—"} | ${severityEmoji(b.severity)} |`,
      );
    });
  }

  // Suggested Improvements
  lines.push(``, `---`, ``, `## Suggested Improvements`, ``);

  if (cpuHotspots.length > 0) {
    lines.push(`### CPU Hotspots`, ``);
    for (const b of cpuHotspots) {
      lines.push(
        `- ${severityEmoji(b.severity)} \`${b.dominantFunction}\` on ${b.thread} (${b.weightPercentage}%): High CPU in this function — reduce view hierarchy depth or batch UI updates.`,
      );
    }
    lines.push(``);
  }

  if (uiHangs.length > 0) {
    lines.push(`### UI Hangs`, ``);
    for (const b of uiHangs) {
      const funcNote =
        b.suspectedFunctions.length > 0
          ? ` Likely caused by: \`${b.suspectedFunctions[0]}\`.`
          : "";
      lines.push(
        `- ${severityEmoji(b.severity)} ${b.hangType} at ${b.startTimeFormatted} (${b.durationMs}ms): Main thread blocked — move heavy work to background queue.${funcNote}`,
      );
    }
    lines.push(``);
  }

  if (memoryLeaks.length > 0) {
    lines.push(`### Memory Leaks`, ``);
    for (const b of memoryLeaks) {
      lines.push(
        `- ${severityEmoji(b.severity)} \`${b.objectType}\` x${b.count} (${formatBytes(b.totalSizeBytes)}) via \`${b.responsibleFrame}\`: Check for retain cycles or strong delegate references.`,
      );
    }
    lines.push(``);
  }

  // Next steps guidance for the agent
  lines.push(`---`, ``, `## Next Steps`, ``);
  lines.push(`Ask the user which path to take:`, ``);
  lines.push(`1. **Investigate further** — use \`profiler-stack-query\` to drill into specific findings:`);
  if (uiHangs.length > 0) {
    lines.push(`   - mode=\`hang_stacks\` hang_index=0 — full native call chains during the worst hang`);
  }
  if (cpuHotspots.length > 0) {
    const topHotspot = cpuHotspots[0]!;
    lines.push(`   - mode=\`function_callers\` function_name=\`${topHotspot.dominantFunction}\` — who calls this hot function`);
    lines.push(`   - mode=\`thread_breakdown\` — CPU distribution across threads`);
  }
  if (memoryLeaks.length > 0) {
    const topLeak = memoryLeaks.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)[0]!;
    lines.push(`   - mode=\`leak_stacks\` object_type=\`${topLeak.objectType}\` — detailed leak analysis`);
  }
  lines.push(`2. **Implement fixes** — apply changes to address the findings above, then re-profile to measure improvement.`);
  lines.push(`3. **Done for now** — save the report for reference.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderExportErrors(
  exportErrors?: Record<string, string>,
): string[] {
  if (!exportErrors || Object.keys(exportErrors).length === 0) return [];
  const lines: string[] = [
    `> **Export warnings:**`,
  ];
  for (const [key, msg] of Object.entries(exportErrors)) {
    lines.push(`> - **${key}**: ${msg}`);
  }
  return lines;
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
  const baseName = path.basename(traceFile, ".trace");
  return path.join(dir, `${baseName}-report.md`);
}

async function writeReport(filePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(filePath, content, "utf8");
  } catch {
    // non-fatal — report is still returned inline
  }
}
