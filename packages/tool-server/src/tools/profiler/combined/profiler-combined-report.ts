import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  getCachedProfilerPaths,
} from "../../../blueprints/react-profiler-session";
import {
  IOS_PROFILER_SESSION_NAMESPACE,
  type IosProfilerSessionApi,
} from "../../../blueprints/ios-profiler-session";
import {
  buildReactAnchor,
  buildIosAnchor,
  reactTimeToWallClock,
  instrumentsNsToWallClock,
  windowsOverlap,
} from "../../../utils/profiler-shared/time-align";
import type { HotCommitSummary } from "../../../utils/react-profiler/types/output";
import type { UiHang, MemoryLeak } from "../../../utils/ios-profiler/types";
import { buildHotCommitSummaries } from "../../../utils/react-profiler/pipeline/00-hot-commits";
import { preprocess } from "../../../utils/react-profiler/pipeline/00-preprocess";
import { readCpuProfile, readCommitTree } from "../../../utils/react-profiler/debug/dump";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z.string().describe("iOS Simulator or device UDID"),
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
  description: `Generate a cross-correlated report combining React Profiler and iOS Instruments data.
Maps iOS Instruments hangs to React commits using wall-clock time alignment.
Requires both react-profiler-analyze and ios-profiler-analyze to have been called first.
Call this tool when both profilers were run in parallel on the same session.`,
  zodSchema,
  services: (params) => ({
    reactSession: `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`,
    iosSession: `${IOS_PROFILER_SESSION_NAMESPACE}:${params.device_id}`,
  }),
  async execute(services) {
    const reactApi = services.reactSession as ReactProfilerSessionApi;
    const iosApi = services.iosSession as IosProfilerSessionApi;

    // Validate prerequisites
    if (!iosApi.parsedData) {
      throw new Error("No iOS Instruments data. Run ios-profiler-analyze first.");
    }

    const sessionPaths = reactApi.sessionPaths ?? getCachedProfilerPaths(reactApi.port);
    if (!sessionPaths?.commitsPath) {
      throw new Error("No React commit data. Run react-profiler-analyze first.");
    }

    const onDisk = await readCommitTree(sessionPaths.commitsPath);
    const commitTree = { commits: onDisk.commits, hookNames: new Map() };
    if (commitTree.commits.length === 0) {
      throw new Error("No React commit data. Run react-profiler-analyze first.");
    }

    let cpuProfile = null;
    if (sessionPaths.cpuProfilePath) {
      cpuProfile = await readCpuProfile(sessionPaths.cpuProfilePath);
    }

    const reactWallStart = reactApi.profileStartWallMs ?? onDisk.meta?.profileStartWallMs ?? null;
    const iosWallStart = iosApi.wallClockStartMs;

    if (!reactWallStart && !iosWallStart) {
      throw new Error(
        "Missing wall-clock anchor from both profilers. Re-run the full profiling session " +
          "(ios-instruments-start + react-profiler-start)."
      );
    } else if (!reactWallStart) {
      throw new Error(
        "Missing wall-clock anchor from React Profiler (profileStartWallMs not found). " +
          "Re-run the profiling session starting with react-profiler-start."
      );
    } else if (!iosWallStart) {
      throw new Error(
        "Missing wall-clock anchor from iOS Profiler (wallClockStartMs not found). " +
          "Re-run the profiling session starting with ios-profiler-start."
      );
    }

    // Build time anchors
    const cpuStartUs = cpuProfile?.startTime ?? 0;
    const reactAnchor = buildReactAnchor(reactWallStart, cpuStartUs);
    const iosAnchor = buildIosAnchor(iosWallStart);

    // Build hot commit summaries from raw data
    const preprocessed = preprocess(commitTree.commits);
    const hotIndices = sessionPaths.hotCommitIndices ?? reactApi.hotCommitIndices ?? [];
    const hotCommits = buildHotCommitSummaries(preprocessed, hotIndices);
    const nonMarginCommits = hotCommits.filter((c) => !c.isMargin);

    const { uiHangs, memoryLeaks } = iosApi.parsedData;

    // Tolerance for time alignment: wall clock jitter + the fact that
    // instruments hang detection and React commit timing may not perfectly align
    const TOLERANCE_MS = 200;

    // Correlate hangs with React commits
    const correlations: HangCommitCorrelation[] = [];

    for (const hang of uiHangs) {
      const hangStartNs = parseHangStartNs(hang.startTimeFormatted);
      const hangDurationNs = hang.durationMs * 1_000_000;
      const hangWallStartMs = instrumentsNsToWallClock(hangStartNs, iosAnchor);
      const hangWallEndMs = instrumentsNsToWallClock(hangStartNs + hangDurationNs, iosAnchor);

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
      "React Profiler + iOS Instruments — Cross-Tool Correlation",
      "",
      `**React Profiler:** ${nonMarginCommits.length} hot commits  `,
      `**iOS Instruments:** ${uiHangs.length} hangs, ${memoryLeaks.length} leaks`,
      "",
      `**Clock offset:** React started ${((reactWallStart - iosWallStart) / 1000).toFixed(1)}s ${reactWallStart > iosWallStart ? "after" : "before"} Instruments`,
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
      lines.push("---");
      lines.push("## Memory Leaks (from Instruments)");
      lines.push("");

      // Try to correlate with React mount/unmount patterns
      const mountComponents = new Set(
        commitTree.commits
          .filter((c) => c.changeDescription?.isFirstMount)
          .map((c) => c.componentName)
      );

      for (const leak of memoryLeaks.slice(0, 10)) {
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
      lines.push("");
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
 * Parse "MM:SS.mmm" formatted hang start time back to nanoseconds.
 */
function parseHangStartNs(formatted: string): number {
  const match = formatted.match(/^(\d+):(\d+)\.(\d+)$/);
  if (!match) return 0;
  const minutes = parseInt(match[1]!, 10);
  const seconds = parseInt(match[2]!, 10);
  const ms = parseInt(match[3]!, 10);
  return (minutes * 60_000 + seconds * 1000 + ms) * 1_000_000;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
