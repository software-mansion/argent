import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
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
  description: `Generate a cross-correlated report combining React Profiler and native profiler data.
Maps native hangs to React commits using wall-clock time alignment.
Requires both react-profiler-analyze and native-profiler-analyze to have been called first.
Call this tool when both profilers were run in parallel on the same session.
Returns a markdown report correlating hangs with React commits, memory leaks, and investigation hints.
Fails if either react-profiler-analyze or native-profiler-analyze has not been called first.`,
  zodSchema,
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
      if (!nativeApi.traceFile) {
        throw new Error("No native profiler data. Run native-profiler-analyze first.");
      }
      const data = await loadAndroidCombinedData(nativeApi.traceFile, nativeApi.appProcess ?? "");
      uiHangs = data.uiHangs;
      memoryLeaks = [];
    } else {
      if (!nativeApi.parsedData) {
        throw new Error("No native profiler data. Run native-profiler-analyze first.");
      }
      uiHangs = nativeApi.parsedData.uiHangs;
      memoryLeaks = nativeApi.parsedData.memoryLeaks;
    }

    // Read-only: resolve react paths from cache only — no live CDP connection needed.
    const sessionPaths = getCachedProfilerPaths(params.port, params.device_id);
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

    const reactWallStart = onDisk.meta?.profileStartWallMs ?? null;
    const nativeWallStart = nativeApi.wallClockStartMs;

    if (!reactWallStart && !nativeWallStart) {
      throw new Error(
        "Missing wall-clock anchor from both profilers. Re-run the full profiling session " +
          "(native-profiler-start + react-profiler-start)."
      );
    } else if (!reactWallStart) {
      throw new Error(
        "Missing wall-clock anchor from React Profiler (profileStartWallMs not found). " +
          "Re-run the profiling session starting with react-profiler-start."
      );
    } else if (!nativeWallStart) {
      throw new Error(
        "Missing wall-clock anchor from native profiler (wallClockStartMs not found). " +
          "Re-run the profiling session starting with native-profiler-start."
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
