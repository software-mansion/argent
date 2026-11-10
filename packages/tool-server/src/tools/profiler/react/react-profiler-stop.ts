import { z } from "zod";
import { FAILURE_CODES, FailureError, ServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  type ProfilerSessionPaths,
  cacheProfilerPaths,
  clearLostProfilerRun,
  getCachedProfilerPaths,
  getLostProfilerRun,
  recordLostProfilerRun,
} from "../../../blueprints/react-profiler-session";
import type {
  HermesCpuProfile,
  DevToolsFiberCommit,
  DevToolsChangeDescription,
  ProfilingDataBackend,
} from "../../../utils/react-profiler/types/input";
import { getDebugDir, writeDumpCompact } from "../../../utils/react-profiler/debug/dump";
import {
  STOP_AND_READ_SCRIPT,
  RESOLVE_FIBER_META_SCRIPT,
} from "../../../utils/react-profiler/scripts";
import { dropStaleLeadingGap } from "../../../utils/react-profiler/pipeline/00-cpu-correlate";
import { lastRunText } from "../../../utils/react-profiler/last-run";
import {
  readTakeover,
  STOP_IN_PROGRESS_NOTE,
} from "../../../utils/react-profiler/session-ownership";
import { RN_ONLY_TOOL_CAPABILITY } from "../../debugger/debugger-service-ref";
import { canonicalDeviceId } from "../../../utils/debugger/device-alias";
import { metroPort, metroPortField } from "../../../utils/debugger/metro-port";
import {
  summarizeRenders,
  renderTimeShare,
  peakRenderShare,
  formatPeakCommit,
  formatShare,
  hasUnnamedSlowCommit,
  SLOW_COMMIT_MS,
  type CommitTiming,
} from "../../../utils/react-profiler/render-summary";

interface StopReadResult {
  live: ProfilingDataBackend | null;
  displayNameById: Record<string, string | null>;
  // False when no renderer interface exposed getDisplayNameForElementID or
  // getDisplayNameForFiberID; every fiber is then unattributed even though
  // commits were captured, which is not a transient-unmount race.
  displayNameApiAvailable?: boolean;
}

interface FiberMetaEntry {
  hookTypes: string[] | null;
  isCompilerOptimized: boolean;
  parentName: string | null;
}
type FiberMetaMap = Record<string, FiberMetaEntry>;

function normalizeChangeDescription(raw: unknown): DevToolsChangeDescription | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const props = Array.isArray(r.props) ? (r.props as string[]) : null;
  // The backend emits boolean `state` only for class components; for function
  // components state changes surface through `hooks[]` + useState/useReducer hookTypes.
  const state = typeof r.state === "boolean" ? (r.state as boolean) : null;
  const hooks = Array.isArray(r.hooks) ? (r.hooks as number[]) : null;
  const context = typeof r.context === "boolean" ? (r.context as boolean) : null;
  const didHooksChange = r.didHooksChange === true;
  const isFirstMount = r.isFirstMount === true;
  return { props, state, hooks, context, didHooksChange, isFirstMount };
}

/**
 * Flatten `ProfilingDataBackend` into `DevToolsFiberCommit[]`. `commitIndex` runs
 * flatly across roots so the map-key grouping in `buildHotCommitSummaries` stays correct.
 *
 * `unattributedByCommit` records fibers whose display name could not be resolved
 * (typically components unmounted before `STOP_AND_READ_SCRIPT` ran), so the report
 * can warn that a breakdown is incomplete. Tuple: `[commitIndex, fiberCount, ms]`.
 *
 * `commitTimings[i]` is the DevTools timestamp and duration of flat commit `i`, recorded for
 * every commit, including one whose fibers were all unattributed.
 */
export function flattenProfilingData(
  merged: ProfilingDataBackend,
  displayNameById: Record<string, string | null>,
  fiberMeta: FiberMetaMap
): {
  commits: DevToolsFiberCommit[];
  totalCommits: number;
  unattributedByCommit: Array<[number, number, number]>;
  commitTimings: CommitTiming[];
} {
  const commits: DevToolsFiberCommit[] = [];
  const unattributedByCommit: Array<[number, number, number]> = [];
  const commitTimings: CommitTiming[] = [];
  let flatCommitIndex = 0;

  for (const root of merged.dataForRoots) {
    for (const c of root.commitData) {
      const actualMap = new Map<number, number>();
      for (const pair of c.fiberActualDurations ?? []) {
        if (Array.isArray(pair) && pair.length >= 2) actualMap.set(pair[0], pair[1]);
      }
      const selfMap = new Map<number, number>();
      for (const pair of c.fiberSelfDurations ?? []) {
        if (Array.isArray(pair) && pair.length >= 2) selfMap.set(pair[0], pair[1]);
      }
      const cdMap = new Map<number, unknown>();
      for (const pair of c.changeDescriptions ?? []) {
        if (Array.isArray(pair) && pair.length >= 2) cdMap.set(pair[0] as number, pair[1]);
      }

      const commitDuration = typeof c.duration === "number" ? c.duration : 0;
      commitTimings.push({ timestamp: c.timestamp, durationMs: commitDuration });

      let droppedCount = 0;
      let droppedMs = 0;

      for (const [fiberID, actualDuration] of actualMap) {
        const componentName = displayNameById[String(fiberID)] ?? null;
        if (!componentName) {
          droppedCount++;
          // selfDuration is exclusive; summing actualDuration (inclusive subtree time)
          // would double-count parent work when both a parent and its child are dropped.
          droppedMs += selfMap.get(fiberID) ?? 0;
          continue;
        }
        const selfDuration = selfMap.get(fiberID) ?? 0;
        const cd = normalizeChangeDescription(cdMap.get(fiberID));
        const meta: FiberMetaEntry | undefined = fiberMeta[componentName];

        commits.push({
          commitIndex: flatCommitIndex,
          timestamp: c.timestamp,
          componentName,
          actualDuration,
          selfDuration,
          commitDuration,
          didRender: actualDuration > 0,
          changeDescription: cd,
          hookTypes: meta?.hookTypes ?? null,
          parentName: meta?.parentName ?? null,
          isCompilerOptimized: meta?.isCompilerOptimized === true,
        });
      }

      if (droppedCount > 0) {
        unattributedByCommit.push([
          flatCommitIndex,
          droppedCount,
          Math.round(droppedMs * 100) / 100,
        ]);
      }

      flatCommitIndex++;
    }
  }

  return { commits, totalCommits: flatCommitIndex, unattributedByCommit, commitTimings };
}

/**
 * For the two calls a stop cannot do without. A long recording can outlast
 * `send`'s 10 s default, and a timed-out call drops the reply, which is the data.
 */
const COLLECT_TIMEOUT_MS = 60_000;

function stopInProgressError(): FailureError {
  return new FailureError(STOP_IN_PROGRESS_NOTE, {
    error_code: FAILURE_CODES.REACT_PROFILER_STOP_IN_PROGRESS,
    failure_stage: "react_profiler_stop_in_progress",
    failure_area: "tool_server",
    error_kind: "not_found",
  });
}

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices: the SAME id you passed to debugger-connect (iOS simulator UDID or Android serial)."
    ),
});

export function createReactProfilerStopTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, Record<string, unknown>> {
  return {
    id: "react-profiler-stop",
    description: `Stop CPU profiling and collect the cpuProfile + React commit tree.
Stores the results for react-profiler-analyze or react-profiler-cpu-summary.
Call react-profiler-start first, then exercise the app, then call this.
Returns { duration_ms, sample_count, fiber_renders_captured, total_react_commits, hot_commit_indices, react_render_ms, react_render_share_pct, react_render_peak_1s_pct }.
If some fibers' display names could not be resolved (typically modals, tooltips or animations that unmounted before stop), it also returns { unattributed_ms, unattributed_fiber_count, unattributed_commit_count }: the work missing from the per-component breakdown. Per-commit durations stay correct.
Fails if no active profiling session exists, another stop is running, the CDP connection was lost during recording, or another session took the run over.`,
    zodSchema,
    interaction: {
      startedMsg: () => "Stopping React profiler",
      completedMsg: () => "Stopped React profiler",
      failedMsg: ({ failureSignal }) =>
        `Failed to stop React profiler: ${failureSignal.error_code}`,
    },
    capability: RN_ONLY_TOOL_CAPABILITY,
    services: () => ({}),
    async execute(_services, params) {
      const port = metroPort(params);
      const deviceId = canonicalDeviceId(params.device_id) ?? params.device_id;
      const psUrn = `${REACT_PROFILER_SESSION_NAMESPACE}:${port}:${deviceId}`;
      const snapshot = registry.getSnapshot();
      const entry = snapshot.services.get(psUrn);

      // What this tool-server knows about its last run here: saved, or lost and why.
      const lastRun = lastRunText(
        getCachedProfilerPaths(port, deviceId),
        getLostProfilerRun(port, deviceId)
      );

      if (!entry || entry.state !== ServiceState.RUNNING) {
        throw new FailureError(
          lastRun
            ? `No active profiling session. ${lastRun} Call react-profiler-start to begin a new session.`
            : "No active profiling session. The session may have been lost to a Metro reload, or " +
                "torn down by a stop-all-simulator-servers — this session rides on the device's " +
                "JS-runtime debugger, which that teardown reaps, and one tool-server serves every " +
                "agent using this argent install. Call react-profiler-start to begin a new session.",
          {
            error_code: FAILURE_CODES.REACT_PROFILER_NO_ACTIVE_SESSION,
            failure_stage: "react_profiler_stop_session_lookup",
            failure_area: "tool_server",
            error_kind: "not_found",
          }
        );
      }

      const api = await registry.resolveService<ReactProfilerSessionApi>(psUrn);
      const cdp = api.cdp;

      if (api.stopping) throw stopInProgressError();

      if (!api.cdp.isConnected()) {
        api.profilingActive = false;
        throw new FailureError(
          "CDP connection lost — profiling data could not be collected. " +
            "Call react-profiler-start to begin a new session.",
          {
            error_code: FAILURE_CODES.REACT_PROFILER_CDP_CONNECTION_LOST,
            failure_stage: "react_profiler_stop_cdp_connection",
            failure_area: "tool_server",
            error_kind: "network",
          }
        );
      }

      // `profilingActive` is set only once react-profiler-start's DevTools-hook
      // checks pass and the sampler is running; stopping a sampler that was never
      // started fails further down with a far less actionable message.
      if (!api.profilingActive) {
        if (lastRun) {
          throw new FailureError(
            `No active profiling run to stop. ${lastRun} Call react-profiler-start to record a new one.`,
            {
              error_code: FAILURE_CODES.REACT_PROFILER_NO_ACTIVE_SESSION,
              failure_stage: "react_profiler_stop_inactive",
              failure_area: "tool_server",
              error_kind: "not_found",
            }
          );
        }
        throw new FailureError(
          "No active profiling run to stop. Either the run ended without its data (a JS reload ends it: Metro's `r`, a red-box Reload, debugger-reload-metro), or Hermes CPU sampling was never started — typically because react-profiler-start failed before reaching the sampler (often on release builds without React DevTools). " +
            "After a reload, call react-profiler-start again. Otherwise check the error react-profiler-start returned, address the underlying cause (rebuild in dev mode, reconnect the debugger, etc.), then call react-profiler-start again.",
          {
            error_code: FAILURE_CODES.REACT_PROFILER_NO_ACTIVE_SESSION,
            failure_stage: "react_profiler_stop_inactive",
            failure_area: "tool_server",
            // Internal session-state, not caller input — matches the session-lookup
            // site above and the native NATIVE_PROFILER_NO_ACTIVE_SESSION twin.
            error_kind: "not_found",
          }
        );
      }

      // Another session may have started a run over this one (react-profiler-start
      // with force, or once this run's heartbeat went stale). Stopping now would
      // stop their recording and read their data as this run's.
      const takeover = await readTakeover(cdp, api);
      if (takeover) {
        // This run is over: record why, and leave the app and the shared
        // Hermes sampler to the session that owns them now. With no session to
        // name, nothing else ends the sampler this run started: a DevTools
        // client outside argent never sends Hermes `Profiler.stop`.
        recordLostProfilerRun(api, "taken_over", takeover.by);
        if (takeover.by === null) await cdp.send("Profiler.stop").catch(() => {});
        api.profilingActive = false;
        api.sessionId = null;
        api.ownerToolServerPid = null;
        const howTakeoversHappen =
          "A takeover happens when another agent or tool-server calls react-profiler-start with " +
          "force, or once a run's heartbeat is 5 minutes old.";
        const replacedBy = takeover.by
          ? `session ${takeover.by}`
          : "a recording with no owner record (a DevTools client outside argent)";
        throw new FailureError(
          takeover.stillRecording
            ? `This profiling run was taken over by ${replacedBy}, which is still recording. Its ` +
                "data was discarded at the takeover, so there is nothing to collect, and the " +
                `other recording was left running. ${howTakeoversHappen} Ask the user before ` +
                "taking over with react-profiler-start { force: true }."
            : "This profiling run was taken over by another session, which has since stopped. " +
                `Its data was discarded at the takeover, so there is nothing to collect. ${howTakeoversHappen} ` +
                "Nothing is recording now: call react-profiler-start to record again.",
          {
            error_code: FAILURE_CODES.REACT_PROFILER_SESSION_TAKEN_OVER,
            failure_stage: "react_profiler_stop_taken_over",
            failure_area: "tool_server",
            error_kind: "not_found",
          }
        );
      }

      // A parallel stop can get here first: the read above awaited the app.
      if (api.stopping) throw stopInProgressError();

      api.profilingActive = false; // reset before the CDP call so state is clean if it throws
      api.stopping = true;

      try {
        const cpuResult = (await cdp.send("Profiler.stop", undefined, COLLECT_TIMEOUT_MS)) as {
          profile?: HermesCpuProfile;
        };
        if (!cpuResult?.profile) {
          throw new FailureError(
            "Hermes Profiler.stop returned no profile data. The CPU sampler may have been reset between start and stop (Metro reload, debugger disconnect). " +
              "Call react-profiler-start to begin a fresh session.",
            {
              error_code: FAILURE_CODES.REACT_PROFILER_NO_CPU_PROFILE,
              failure_stage: "react_profiler_stop_cpu_profile",
              failure_area: "tool_server",
              error_kind: "unknown",
            }
          );
        }
        const profile = cpuResult.profile;
        if (
          !Array.isArray(profile.samples) ||
          !Array.isArray(profile.nodes) ||
          !Array.isArray(profile.timeDeltas)
        ) {
          throw new FailureError(
            "Hermes Profiler.stop returned a malformed profile (missing samples/nodes/timeDeltas). " +
              "This usually means CPU sampling was never actually started for this session — most often a release build without React DevTools, or a Metro reload between start and stop. " +
              "Call react-profiler-start on a dev build and retry.",
            {
              error_code: FAILURE_CODES.REACT_PROFILER_NO_CPU_PROFILE,
              failure_stage: "react_profiler_stop_malformed_profile",
              failure_area: "tool_server",
              error_kind: "unknown",
            }
          );
        }

        // Before anything reads a duration or a sample time from it.
        dropStaleLeadingGap(profile);

        // One round-trip: stop the backend profiler, read the live buffer, and resolve
        // every referenced fiberID to a display name.
        const stopReadStr = (await cdp.send(
          "Runtime.evaluate",
          { expression: STOP_AND_READ_SCRIPT, returnByValue: true },
          COLLECT_TIMEOUT_MS
        )) as { result?: { value?: string }; exceptionDetails?: { text?: string } };
        if (stopReadStr.exceptionDetails) {
          throw new FailureError(
            `Runtime exception while reading profiling data: ${stopReadStr.exceptionDetails.text ?? "unknown"}`,
            {
              error_code: FAILURE_CODES.REACT_PROFILER_RUNTIME_EXCEPTION,
              failure_stage: "react_profiler_stop_runtime_read",
              failure_area: "tool_server",
              error_kind: "unknown",
            }
          );
        }
        const stopReadRaw = stopReadStr.result?.value;
        if (!stopReadRaw) {
          throw new FailureError("No profiling data returned from runtime.", {
            error_code: FAILURE_CODES.REACT_PROFILER_NO_RUNTIME_DATA,
            failure_stage: "react_profiler_stop_runtime_read",
            failure_area: "tool_server",
            error_kind: "unknown",
          });
        }
        const stopRead = JSON.parse(stopReadRaw) as StopReadResult;

        const merged: ProfilingDataBackend = stopRead.live ?? { dataForRoots: [] };
        const backendCommitCount = merged.dataForRoots.reduce(
          (a, r) => a + (r.commitData?.length ?? 0),
          0
        );

        let fiberMeta: FiberMetaMap = {};
        if (backendCommitCount > 0) {
          try {
            const metaStr = (await cdp.send(
              "Runtime.evaluate",
              { expression: RESOLVE_FIBER_META_SCRIPT, returnByValue: true },
              15_000
            )) as { result?: { value?: string } };
            if (metaStr.result?.value) {
              fiberMeta = JSON.parse(metaStr.result.value) as FiberMetaMap;
            }
          } catch {
            // non-fatal — fiber metadata falls back to defaults
          }
        }

        const {
          commits: allCommits,
          totalCommits,
          unattributedByCommit,
          commitTimings,
        } = flattenProfilingData(merged, stopRead.displayNameById, fiberMeta);

        // Counts over every commit, saved next to the hot ±1 commits below: cheap
        // but frequent renders never reach the 16ms floor.
        const renderSummary = summarizeRenders(
          allCommits,
          commitTimings,
          (profile.endTime - profile.startTime) / 1000
        );

        const commitHeat = new Map<number, number>();
        let anyCompilerOptimized = false;
        for (const c of allCommits) {
          if (c.isCompilerOptimized) anyCompilerOptimized = true;
          // The report builds a commit from its fibers that rendered, so a commit
          // without one is not hot here either: it would be counted and never shown.
          if (!c.didRender) continue;
          const prev = commitHeat.get(c.commitIndex) ?? 0;
          if (c.commitDuration > prev) commitHeat.set(c.commitIndex, c.commitDuration);
        }

        const interestingKeys = [...commitHeat.keys()].filter(
          (k) => (commitHeat.get(k) ?? 0) >= SLOW_COMMIT_MS
        );

        const hotSet = new Set(interestingKeys);
        const marginSet = new Set<number>();
        for (const ci of interestingKeys) {
          if (commitHeat.has(ci - 1) && !hotSet.has(ci - 1)) marginSet.add(ci - 1);
          if (commitHeat.has(ci + 1) && !hotSet.has(ci + 1)) marginSet.add(ci + 1);
        }
        const keepSet = new Set([...hotSet, ...marginSet]);

        const filteredCommits: DevToolsFiberCommit[] =
          interestingKeys.length === 0 ? [] : allCommits.filter((c) => keepSet.has(c.commitIndex));

        api.anyCompilerOptimized = anyCompilerOptimized;
        api.totalReactCommits = totalCommits;
        api.hotCommitIndices = interestingKeys;

        const commitTree = { commits: filteredCommits, hookNames: new Map() };

        const sessionTs = new Date()
          .toISOString()
          .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
          .slice(0, 15);

        const debugDir = await getDebugDir();

        const cpuProfilePath = await writeDumpCompact(
          debugDir,
          `react-profiler-${sessionTs}_cpu.json`,
          profile
        );
        const commitsPath = await writeDumpCompact(
          debugDir,
          `react-profiler-${sessionTs}_commits.json`,
          {
            commits: commitTree.commits,
            meta: {
              detectedArchitecture: api.detectedArchitecture,
              anyCompilerOptimized: api.anyCompilerOptimized,
              hotCommitIndices: api.hotCommitIndices,
              totalReactCommits: api.totalReactCommits,
              profileStartWallMs: api.profileStartWallMs,
              projectRoot: api.projectRoot,
              deviceId: api.deviceId,
              port: api.port,
              appName: api.appName,
              deviceName: api.deviceName,
              unattributedByCommit: unattributedByCommit.length > 0 ? unattributedByCommit : null,
              renderSummary,
            },
          }
        );

        const sessionPaths: ProfilerSessionPaths = {
          sessionId: sessionTs,
          debugDir,
          cpuProfilePath,
          commitsPath,
          cpuSampleIndexPath: null,
          detectedArchitecture: api.detectedArchitecture,
          anyCompilerOptimized: api.anyCompilerOptimized,
          hotCommitIndices: api.hotCommitIndices,
          totalReactCommits: api.totalReactCommits,
        };

        cacheProfilerPaths(api.port, sessionPaths, api.deviceId);
        clearLostProfilerRun(api.port, api.deviceId);
        api.sessionPaths = sessionPaths;
        api.sessionId = null;
        api.ownerToolServerPid = null;
        api.disposeSession();

        const duration_ms = (profile.endTime - profile.startTime) / 1000;

        const response: Record<string, unknown> = {
          duration_ms,
          sample_count: profile.samples.length,
          fiber_renders_captured: allCommits.length,
        };
        if (totalCommits > 0) {
          response["total_react_commits"] = totalCommits;
          response["hot_commit_indices"] = api.hotCommitIndices ?? [];
          response["any_compiler_optimized"] = api.anyCompilerOptimized ?? false;
          response["fiber_renders_analyzed"] = filteredCommits.length;
          response["react_render_ms"] = renderSummary.totalRenderMs;
          response["react_render_share_pct"] =
            Math.round(renderTimeShare(renderSummary) * 1000) / 10;
          response["react_render_peak_1s_pct"] =
            Math.round(peakRenderShare(renderSummary) * 1000) / 10;
          const hotCount = api.hotCommitIndices?.length ?? 0;
          const share = formatShare(renderTimeShare(renderSummary));
          if (hotCount === 0 && hasUnnamedSlowCommit(renderSummary)) {
            response["selection_note"] =
              `The slowest commit took ${formatPeakCommit(renderSummary.maxCommitMs)}, but none of its components could be named, so no commit was kept. React rendered for ${share} of the session`;
          } else if (hotCount === 0) {
            response["selection_note"] =
              `No commit reached 16ms. React rendered for ${share} of the session, peak ${formatShare(peakRenderShare(renderSummary))} in 1 s`;
          } else if (hotCount < totalCommits) {
            response["selection_note"] =
              `${hotCount} of ${totalCommits} commits at ≥16ms absolute floor`;
          }
          if (unattributedByCommit.length > 0) {
            let totalMs = 0;
            let totalFibers = 0;
            for (const [, count, ms] of unattributedByCommit) {
              totalFibers += count;
              totalMs += ms;
            }
            response["unattributed_ms"] = Math.round(totalMs * 100) / 100;
            response["unattributed_fiber_count"] = totalFibers;
            response["unattributed_commit_count"] = unattributedByCommit.length;
            // With no display-name accessor every fiber is unattributed by
            // construction, so don't point the operator at an unmount race.
            if (stopRead.displayNameApiAvailable === false) {
              response["unattributed_reason"] =
                "react-devtools backend in this app does not expose a recognized display-name accessor (neither getDisplayNameForElementID nor getDisplayNameForFiberID). The component breakdown is unavailable for this profiling session; commit-level timing data remains correct.";
            }
          }
        }

        return response;
      } catch (err) {
        // `sessionId` stays set, so a teardown still ends what this stop left
        // recording. The record outlives this session node.
        recordLostProfilerRun(api, "stop_failed");
        throw err;
      } finally {
        api.stopping = false;
      }
    },
  };
}
