import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import { getCachedProfilerPaths } from "../../../blueprints/react-profiler-session";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import {
  buildReactAnchor,
  buildIosAnchor,
  buildPerfettoAnchor,
  reactTimeToWallClock,
  instrumentsNsToWallClock,
  windowsOverlap,
  type TimeAnchor,
} from "../../../utils/profiler-shared/time-align";
import type { HotCommitSummary } from "../../../utils/react-profiler/types/output";
import type { UiHang, MemoryLeak } from "../../../utils/profiler-shared/types";
import { formatBytes } from "../../../utils/profiler-shared/format";
import { loadAndroidCombinedData } from "../../../utils/android-profiler/pipeline/index";
import { buildHotCommitSummaries } from "../../../utils/react-profiler/pipeline/00-hot-commits";
import { preprocess } from "../../../utils/react-profiler/pipeline/00-preprocess";
import { readCpuProfile, readCommitTree } from "../../../utils/react-profiler/debug/dump";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z.string().describe("iOS Simulator/device UDID or Android serial"),
});

interface HangCommitCorrelation {
  hang: UiHang;
  hangWallStartMs: number;
  hangWallEndMs: number;
  overlappingCommits: {
    commit: HotCommitSummary;
    commitWallStartMs: number;
    commitWallEndMs: number;
  }[];
}

export const profilerCombinedReportTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "profiler-combined-report",
  description: `Generate a cross-correlated report combining React Profiler and native profiler data.
Maps native hangs to React commits using wall-clock time alignment.
Requires both react-profiler-analyze and native-profiler-analyze to have been called first.
Call this tool when both profilers were run in parallel on the same session.
Returns a markdown report correlating hangs with React commits, memory leaks, and investigation hints.
Fails if either react-profiler-analyze or native-profiler-analyze has not been called first.`,
  zodSchema,
  // Combines React (Hermes) + native traces. iOS reads xctrace output;
  // Android re-queries the Perfetto .pftrace via loadAndroidCombinedData. The
  // capture half exists on neither platform's Chromium.
  capability: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
  },
  services: (params) => ({
    nativeSession: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params) {
    const nativeApi = services.nativeSession as NativeProfilerSessionApi;

    // For iOS, the analyze step cached uiHangs + memoryLeaks in parsedData.
    // For Android, drill-down re-queries the .pftrace, so we load the same
    // shape on demand here.
    let uiHangs: UiHang[];
    let memoryLeaks: MemoryLeak[];
    if (nativeApi.platform === "android") {
      // Gate on the exported .pftrace (set at stop), not just traceFile (set at
      // start) -- otherwise a session that started native profiling but never ran
      // stop/analyze would silently render an empty "0 hangs" report instead of
      // this clear error. Mirrors profiler-stack-query's Android gate.
      if (!nativeApi.exportedFiles?.pftrace || !nativeApi.traceFile) {
        throw new FailureError(
          "No Android trace loaded. Run native-profiler-stop → native-profiler-analyze first.",
          {
            error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
            failure_stage: "profiler_combined_report_load_native_data",
            failure_area: "tool_server",
            error_kind: "validation",
          }
        );
      }
      const data = await loadAndroidCombinedData(nativeApi.traceFile, nativeApi.appProcess ?? "");
      uiHangs = data.uiHangs;
      memoryLeaks = [];
    } else {
      if (!nativeApi.parsedData) {
        throw new FailureError("No native profiler data. Run native-profiler-analyze first.", {
          error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
          failure_stage: "profiler_combined_report_load_native_data",
          failure_area: "tool_server",
          error_kind: "validation",
        });
      }
      uiHangs = nativeApi.parsedData.uiHangs;
      memoryLeaks = nativeApi.parsedData.memoryLeaks;
    }

    // Read-only: resolve react paths from cache only — no live CDP connection needed.
    const sessionPaths = getCachedProfilerPaths(params.port, params.device_id);
    if (!sessionPaths?.commitsPath) {
      throw new FailureError("No React commit data. Run react-profiler-analyze first.", {
        error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
        failure_stage: "profiler_combined_report_load_react_data",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }

    const onDisk = await readCommitTree(sessionPaths.commitsPath);
    const commitTree = { commits: onDisk.commits, hookNames: new Map() };
    if (commitTree.commits.length === 0) {
      throw new FailureError("No React commit data. Run react-profiler-analyze first.", {
        error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
        failure_stage: "profiler_combined_report_load_react_data",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }

    let cpuProfile = null;
    if (sessionPaths.cpuProfilePath) {
      cpuProfile = await readCpuProfile(sessionPaths.cpuProfilePath);
    }

    const reactWallStart = onDisk.meta?.profileStartWallMs ?? null;
    const nativeWallStart = nativeApi.wallClockStartMs;

    if (!reactWallStart && !nativeWallStart) {
      throw new FailureError(
        "Missing wall-clock anchor from both profilers. Re-run the full profiling session " +
          "(native-profiler-start + react-profiler-start).",
        {
          error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
          failure_stage: "profiler_combined_report_time_anchor",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    } else if (!reactWallStart) {
      throw new FailureError(
        "Missing wall-clock anchor from React Profiler (profileStartWallMs not found). " +
          "Re-run the profiling session starting with react-profiler-start.",
        {
          error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
          failure_stage: "profiler_combined_report_time_anchor",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    } else if (!nativeWallStart) {
      throw new FailureError(
        "Missing wall-clock anchor from native profiler (wallClockStartMs not found). " +
          "Re-run the profiling session starting with native-profiler-start.",
        {
          error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
          failure_stage: "profiler_combined_report_time_anchor",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    // Build time anchors
    const cpuStartUs = cpuProfile?.startTime ?? 0;
    const reactAnchor = buildReactAnchor(reactWallStart, cpuStartUs);
    const nativeAnchor: TimeAnchor =
      nativeApi.platform === "android"
        ? buildPerfettoAnchor(nativeWallStart)
        : buildIosAnchor(nativeWallStart);

    // Build hot commit summaries from raw data
    const preprocessed = preprocess(commitTree.commits);
    const hotIndices = sessionPaths.hotCommitIndices ?? [];
    const hotCommits = buildHotCommitSummaries(preprocessed, hotIndices);
    const nonMarginCommits = hotCommits.filter((c) => !c.isMargin);

    // Tolerance for time alignment: wall clock jitter + the fact that
    // instruments hang detection and React commit timing may not perfectly align
    const TOLERANCE_MS = 200;

    // Correlate hangs with React commits
    const correlations: HangCommitCorrelation[] = [];

    for (const hang of uiHangs) {
      const hangWallStartMs = instrumentsNsToWallClock(hang.startNs, nativeAnchor);
      const hangWallEndMs = instrumentsNsToWallClock(hang.endNs, nativeAnchor);

      const overlapping = nonMarginCommits
        .map((commit) => {
          const commitWallStartMs = reactTimeToWallClock(commit.timestampMs, reactAnchor);
          const commitWallEndMs = commitWallStartMs + commit.totalRenderMs;
          return { commit, commitWallStartMs, commitWallEndMs };
        })
        .filter(({ commitWallStartMs, commitWallEndMs }) =>
          windowsOverlap(
            hangWallStartMs,
            hangWallEndMs,
            commitWallStartMs,
            commitWallEndMs,
            TOLERANCE_MS
          )
        )
        .sort((a, b) => b.commit.totalRenderMs - a.commit.totalRenderMs);

      correlations.push({
        hang,
        hangWallStartMs,
        hangWallEndMs,
        overlappingCommits: overlapping,
      });
    }

    // Render the combined report
    const lines: string[] = [
      "# Combined Profiling Report",
      "",
      "React Profiler + Native Profiler — Cross-Tool Correlation",
      "",
      `**React Profiler:** ${nonMarginCommits.length} hot commits  `,
      `**Native Profiler:** ${uiHangs.length} hangs, ${memoryLeaks.length} leaks`,
      "",
      `**Clock offset:** React started ${((reactWallStart - nativeWallStart) / 1000).toFixed(1)}s ${reactWallStart > nativeWallStart ? "after" : "before"} native profiler`,
      "",
    ];

    // Hang-Commit Correlations
    if (correlations.length > 0) {
      lines.push("---");
      lines.push("## Hang ↔ Commit Correlations");
      lines.push("");

      const correlated = correlations.filter((c) => c.overlappingCommits.length > 0);
      const uncorrelated = correlations.filter((c) => c.overlappingCommits.length === 0);

      if (correlated.length > 0) {
        for (const corr of correlated) {
          const { hang, overlappingCommits } = corr;
          const topCommit = overlappingCommits[0]!;

          lines.push(
            `### ${hang.hangType} at ${hang.startTimeFormatted} (${hang.durationMs}ms) ↔ Commit #${topCommit.commit.commitIndex} (${topCommit.commit.totalRenderMs}ms)`
          );
          lines.push("");

          // Explain the ratio
          const ratio = hang.durationMs > 0 ? topCommit.commit.totalRenderMs / hang.durationMs : 0;
          if (ratio > 2) {
            lines.push(
              `> React reports ${topCommit.commit.totalRenderMs}ms vs Instruments' ${hang.durationMs}ms ` +
                `(~${ratio.toFixed(0)}× ratio — expected in dev mode where JS is ~3–4× slower).`
            );
            lines.push("");
          }

          // What caused it
          if (topCommit.commit.isInitialRender) {
            lines.push(
              `**Cause:** Initial mount of ${topCommit.commit.totalComponentCount} components`
            );
          } else if (topCommit.commit.rootCauseComponent) {
            lines.push(
              `**Cause:** \`${topCommit.commit.rootCauseComponent}\` re-rendered` +
                (topCommit.commit.rootCauseReason ? ` (${topCommit.commit.rootCauseReason})` : "")
            );
          }

          // Top components
          if (topCommit.commit.components.length > 0) {
            lines.push("");
            lines.push("Top components in this commit:");
            for (const comp of topCommit.commit.components.slice(0, 5)) {
              const countStr = comp.count > 1 ? ` ×${comp.count}` : "";
              lines.push(`- \`${comp.name}\`${countStr} ${comp.selfDurationMs}ms`);
            }
          }

          // CPU from both sides
          if (topCommit.commit.cpuHotspots && topCommit.commit.cpuHotspots.length > 0) {
            lines.push("");
            lines.push("JS CPU (Hermes) during this commit:");
            for (const hs of topCommit.commit.cpuHotspots.slice(0, 3)) {
              lines.push(`- \`${hs.name}\` self=${hs.selfMs}ms`);
            }
          }

          if (hang.suspectedFunctions.length > 0) {
            lines.push("");
            lines.push("Native CPU (Instruments) during this hang:");
            for (const fn of hang.suspectedFunctions.slice(0, 3)) {
              lines.push(`- \`${fn}\``);
            }
          }

          if (overlappingCommits.length > 1) {
            lines.push("");
            lines.push(
              `_${overlappingCommits.length - 1} more commit(s) also overlap with this hang._`
            );
          }

          lines.push("");
        }
      }

      if (uncorrelated.length > 0) {
        lines.push("### Hangs Without React Commit Match");
        lines.push("");
        lines.push("These hangs occurred outside React commit windows — likely pure native work:");
        lines.push("");
        for (const corr of uncorrelated) {
          const { hang } = corr;
          lines.push(
            `- **${hang.hangType}** at ${hang.startTimeFormatted} (${hang.durationMs}ms)` +
              (hang.suspectedFunctions.length > 0 ? ` — \`${hang.suspectedFunctions[0]}\`` : "")
          );
        }
        lines.push("");
      }
    }

    // Memory leaks section
    if (memoryLeaks.length > 0) {
      // Try to correlate with React mount/unmount patterns
      const mountComponents = new Set(
        commitTree.commits
          .filter((c) => c.changeDescription?.isFirstMount)
          .map((c) => c.componentName)
      );

      lines.push(...renderCombinedMemoryLeaks(memoryLeaks, mountComponents));
    }

    // Summary of opportunities
    lines.push("---");
    lines.push("## Investigation Hints");
    lines.push("");
    lines.push("Use these query tools to drill deeper:");
    lines.push("");

    if (nonMarginCommits.length > 0) {
      const worstCommit = nonMarginCommits.sort((a, b) => b.totalRenderMs - a.totalRenderMs)[0]!;
      lines.push(
        `- \`profiler-cpu-query\` mode=\`component_cpu\` — investigate CPU during specific component commits`
      );
      lines.push(
        `- \`profiler-commit-query\` mode=\`by_index\` commit_index=${worstCommit.commitIndex} — full detail of worst commit`
      );
    }

    if (uiHangs.length > 0) {
      lines.push(
        `- \`profiler-stack-query\` mode=\`hang_stacks\` hang_index=0 — native call stacks during worst hang`
      );
    }

    if (memoryLeaks.length > 0) {
      lines.push(`- \`profiler-stack-query\` mode=\`leak_stacks\` — memory leak details`);
    }

    return lines.join("\n");
  },
};

/**
 * Render the combined report's Memory Leaks section, mirroring the attribution
 * split used by the iOS analyze report (`utils/ios-profiler/render.ts`).
 * Attributed leaks (a resolved responsible frame) are listed individually and
 * heuristically tied to recently-mounted React components; unattributed leaks
 * (`<Call stack limit reached>` under `xctrace --attach`) are collapsed into one
 * low-confidence YELLOW caveat so the simulator's benign system-allocation noise
 * can't masquerade as a wall of confirmed leaks. The caveat's hint is capture-mode
 * aware (mirroring render.ts): if some leaks WERE attributed, malloc stack logging
 * was on, so it won't advise enabling the very thing the user just used. Exported
 * for unit testing.
 */
export function renderCombinedMemoryLeaks(
  memoryLeaks: MemoryLeak[],
  mountComponents: Set<string>
): string[] {
  if (memoryLeaks.length === 0) return [];

  const attributedLeaks = memoryLeaks.filter((leak) => leak.attributed);
  const unattributedLeaks = memoryLeaks.filter((leak) => !leak.attributed);

  const lines: string[] = ["---", "## Memory Leaks (from Instruments)", ""];

  if (attributedLeaks.length > 0) {
    for (const leak of attributedLeaks) {
      const possibleComponent = [...mountComponents].find(
        (name) =>
          leak.objectType.toLowerCase().includes(name.toLowerCase()) ||
          leak.responsibleFrame.toLowerCase().includes(name.toLowerCase())
      );

      lines.push(
        `- **\`${leak.objectType}\`** ${formatBytes(leak.totalSizeBytes)} (${leak.count}×) — \`${leak.responsibleFrame}\`` +
          (possibleComponent ? ` — may relate to \`${possibleComponent}\` mount/unmount` : "")
      );
    }
  } else {
    lines.push("_No attributed leaks — nothing with a resolved responsible frame._");
  }

  if (unattributedLeaks.length > 0) {
    const objs = unattributedLeaks.reduce((s, b) => s + b.count, 0);
    const bytes = unattributedLeaks.reduce((s, b) => s + b.totalSizeBytes, 0);
    // Mirror render.ts's split: when this same capture ALSO produced attributed
    // leaks, the app was launched under malloc stack logging (the only way a
    // responsible frame is recorded), so the unattributed remainder is freed-region
    // reuse / pre-recording noise — telling the user to "re-run with malloc stack
    // logging" would be advising the thing they just did. Only when nothing is
    // attributed is the --attach hint apt. Infer capture mode from the attributed
    // count (the render layer has no direct capture-mode signal).
    const hint =
      attributedLeaks.length > 0
        ? `Some leaks here were attributed, so malloc stack logging was active — these remaining ` +
          `groups carry no allocation backtrace (freed-region reuse, or allocations from before ` +
          `recording started) and are most likely benign system allocations rather than confirmed app leaks.`
        : `Argent records via \`xctrace --attach\`, which has no malloc-stack history, so these are most likely ` +
          `benign system allocations rather than confirmed app leaks. For attributed stacks, capture with malloc ` +
          `stack logging enabled at launch.`;
    lines.push(
      ``,
      `> 🟡 **${unattributedLeaks.length} unattributed leak group(s)** ` +
        `(${objs} object(s), ${formatBytes(bytes)}): responsible frame \`<Call stack limit reached>\`, no library. ` +
        hint
    );
  }

  lines.push("");
  return lines;
}
