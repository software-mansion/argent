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
import {
  isCaptureInFlight,
  inFlightGuardMessage,
} from "../../../utils/profiler-shared/capture-guard";
import { renderUnattributedLeaksNote } from "../../../utils/ios-profiler/render";
import { loadAndroidCombinedData } from "../../../utils/android-profiler/pipeline/index";
import { buildHotCommitSummaries } from "../../../utils/react-profiler/pipeline/00-hot-commits";
import { preprocess } from "../../../utils/react-profiler/pipeline/00-preprocess";
import { readCpuProfile, readCommitTree } from "../../../utils/react-profiler/debug/dump";
import { metroDeviceIdParam } from "../../../utils/debugger/device-id-param";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: metroDeviceIdParam("iOS Simulator/device UDID or Android serial"),
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
  interaction: {
    startedMsg: () => "Building combined performance report",
    completedMsg: () => "Built combined performance report",
    failedMsg: ({ failureSignal }) =>
      `Failed to build combined performance report: ${failureSignal.error_code}`,
  },
  description: `Generate a cross-correlated report combining React Profiler and native profiler data.
Maps native hangs to React commits using wall-clock time alignment.
Requires both react-profiler-analyze and native-profiler-analyze to have been called first.
Call this tool when both profilers were run in parallel on the same session.
Returns a markdown report correlating hangs with React commits, memory leaks, and investigation hints.
Fails if either react-profiler-analyze or native-profiler-analyze has not been called first.`,
  zodSchema,
  // iOS reads xctrace output; Android re-queries the Perfetto .pftrace via
  // loadAndroidCombinedData. Chromium has no native trace capture.
  capability: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
  },
  services: (params) => ({
    nativeSession: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params) {
    const nativeApi = services.nativeSession as NativeProfilerSessionApi;

    // A newer capture in flight makes the frozen iOS parsedData this report
    // renders stale. The retryAction names native-profiler-analyze because stop
    // alone does not rewrite parsedData, so "stop then re-run" would render the
    // previous capture again.
    if (isCaptureInFlight(nativeApi)) {
      throw new FailureError(
        inFlightGuardMessage(
          nativeApi,
          "run native-profiler-analyze, then re-run profiler-combined-report"
        ),
        {
          error_code: FAILURE_CODES.NATIVE_PROFILER_SESSION_ALREADY_RUNNING,
          failure_stage: "profiler_combined_report_session_state",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    // A session with no capture state at all was minted by THIS call: the
    // device_id matched no existing session, so nothing is known about the
    // device. Say so without naming a platform — classification is shape-based
    // and falls back to "android" for any opaque id (utils/device-info.ts:52),
    // so an id this tool cannot place would otherwise be reported as an Android
    // device (#618). That happens routinely: a forwarded Metro logicalDeviceId
    // resolves only while a debugger connection is live, and the alias is
    // dropped when it disposes.
    if (!nativeApi.traceFile && !nativeApi.exportedFiles && !nativeApi.parsedData) {
      throw new FailureError(
        `No native profiler capture is loaded for device \`${params.device_id}\`. Run ` +
          "native-profiler-start → native-profiler-stop → native-profiler-analyze on this device " +
          "first. (If that id came from debugger-connect, pass the id from list-devices instead — " +
          "the simulator UDID or adb serial — since profiler sessions are keyed by that one.)",
        {
          error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
          failure_stage: "profiler_combined_report_load_native_data",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    }

    let uiHangs: UiHang[];
    let memoryLeaks: MemoryLeak[];
    // iOS froze uiHangs + memoryLeaks into parsedData at analyze; Android
    // re-queries the .pftrace on demand here.
    if (nativeApi.platform === "android") {
      // Gate on the exported .pftrace (set at stop), not just traceFile (set at
      // start): a session that started native profiling but never ran
      // stop/analyze would otherwise render an empty "0 hangs" report. Mirrors
      // profiler-stack-query's Android gate.
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

    // Cache lookup only — this report needs no live CDP connection.
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
    // iOS anchors the FROZEN parsedData hangs, so it must use the anchor frozen
    // with them at analyze, not the live session field — a later
    // native-profiler-start re-stamps that field and would shift every hang.
    // Android re-derives hangs from the live traceFile, so its live anchor
    // stays consistent.
    const nativeWallStart =
      nativeApi.platform === "android"
        ? nativeApi.wallClockStartMs
        : (nativeApi.parsedData?.wallClockStartMs ?? null);

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

    const cpuStartUs = cpuProfile?.startTime ?? 0;
    const reactAnchor = buildReactAnchor(reactWallStart, cpuStartUs);
    const nativeAnchor: TimeAnchor =
      nativeApi.platform === "android"
        ? buildPerfettoAnchor(nativeWallStart)
        : buildIosAnchor(nativeWallStart);

    const preprocessed = preprocess(commitTree.commits);
    const hotIndices = sessionPaths.hotCommitIndices ?? [];
    const hotCommits = buildHotCommitSummaries(preprocessed, hotIndices);
    const nonMarginCommits = hotCommits.filter((c) => !c.isMargin);

    // Absorbs wall-clock jitter between native hang detection and React commit timing.
    const TOLERANCE_MS = 200;

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

          const ratio = hang.durationMs > 0 ? topCommit.commit.totalRenderMs / hang.durationMs : 0;
          if (ratio > 2) {
            lines.push(
              `> React reports ${topCommit.commit.totalRenderMs}ms vs Instruments' ${hang.durationMs}ms ` +
                `(~${ratio.toFixed(0)}× ratio — expected in dev mode where JS is ~3–4× slower).`
            );
            lines.push("");
          }

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

          if (topCommit.commit.components.length > 0) {
            lines.push("");
            lines.push("Top components in this commit:");
            for (const comp of topCommit.commit.components.slice(0, 5)) {
              const countStr = comp.count > 1 ? ` ×${comp.count}` : "";
              lines.push(`- \`${comp.name}\`${countStr} ${comp.selfDurationMs}ms`);
            }
          }

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

    if (memoryLeaks.length > 0) {
      const mountComponents = new Set(
        commitTree.commits
          .filter((c) => c.changeDescription?.isFirstMount)
          .map((c) => c.componentName)
      );

      lines.push(
        ...renderCombinedMemoryLeaks(
          memoryLeaks,
          mountComponents,
          // From parsedData, not the live session field: a recording started
          // after analyze must not re-label the data rendered here.
          nativeApi.parsedData?.mallocStackLogging ?? null
        )
      );
    }

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
 * Memory Leaks section of the combined report, mirroring the attribution split
 * of the iOS analyze report (`utils/ios-profiler/render.ts`). Attributed leaks
 * are listed individually and heuristically tied to recently-mounted React
 * components; unattributed ones collapse into one low-confidence caveat so
 * benign system-allocation noise can't masquerade as a wall of confirmed leaks.
 * That caveat comes from render.ts's shared `renderUnattributedLeaksNote`, so
 * its wording and capture-mode handling cannot drift from the analyze report.
 * A null/undefined `mallocStackLogging` makes it infer the capture mode from
 * the attributed count. Exported for unit testing.
 */
export function renderCombinedMemoryLeaks(
  memoryLeaks: MemoryLeak[],
  mountComponents: Set<string>,
  mallocStackLogging?: boolean | null
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
    lines.push(
      ``,
      renderUnattributedLeaksNote(unattributedLeaks, attributedLeaks.length, mallocStackLogging)
    );
  }

  lines.push("");
  return lines;
}
