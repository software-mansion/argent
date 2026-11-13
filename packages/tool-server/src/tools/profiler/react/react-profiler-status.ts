import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  getCachedProfilerPaths,
  getLostProfilerRun,
} from "../../../blueprints/react-profiler-session";
import {
  buildHeartbeatScript,
  REACT_NATIVE_PROFILER_SETUP_SCRIPT,
  READ_STATE_SCRIPT,
} from "../../../utils/react-profiler/scripts";
import {
  classifyStaleness,
  STALE_OWN_RUN_NOTE,
  STOP_IN_PROGRESS_NOTE,
  takeoverOf,
  type ProfilerSessionOwner,
} from "../../../utils/react-profiler/session-ownership";
import {
  lastRunText,
  lostRunCauseText,
  lostRunInfo,
  lostRunText,
  savedSessionInfo,
  savedSessionText,
  type LiveLostRunCause,
  type LostRunInfo,
  type SavedSessionInfo,
} from "../../../utils/react-profiler/last-run";
import { REACT_PROFILER_TOOL_CAPABILITY } from "../../debugger/debugger-service-ref";
import { canonicalDeviceId } from "../../../utils/debugger/device-alias";
import { metroPort, metroPortField } from "../../../utils/debugger/metro-port";

type ReadStateResult =
  | { hookExists: false }
  | { hookExists: true; rendererInterfaceFound: false }
  | {
      hookExists: true;
      rendererInterfaceFound: true;
      isRunning: boolean;
      owner: ProfilerSessionOwner | null;
      nowEpochMs: number;
    };

/**
 * - `active`: this tool-server's run is recording, or a stop is collecting it.
 * - `saved`: nothing is recording; the last run was stopped and saved.
 * - `lost`: this tool-server's last run ended without being saved.
 * - `taken_over`: another session is recording, or replaced this tool-server's run.
 * - `not_started`: nothing is recording and this tool-server has no run on record.
 * - `no_react_runtime`: no React runtime to read.
 */
type SessionStatus =
  "active" | "saved" | "lost" | "taken_over" | "not_started" | "no_react_runtime";

interface StatusResponse extends Record<string, unknown> {
  hook_exists: boolean;
  renderer_interface_found: boolean;
  is_running: boolean;
  current_session_id: string | null;
  current_owner: ProfilerSessionOwner | null;
  session_status: SessionStatus;
  note: string;
  stale?: boolean;
  heartbeat_age_seconds?: number | null;
  saved_session?: SavedSessionInfo;
  lost_run?: LostRunInfo;
}

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device logicalDeviceId from debugger-connect (iOS simulator UDID<flag:macos-apps>, Mac app id</flag:macos-apps> or Android logicalDeviceId)."
    ),
});

export function createReactProfilerStatusTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, Record<string, unknown>> {
  return {
    id: "react-profiler-status",
    description: `Check the state of the React profiler session. Use when resuming after an interruption (debugger disconnect, unexpected error, agent pause) to decide whether to continue with react-profiler-stop, start a new session, or reconnect the debugger. Returns { session_status, is_running, current_owner, note, … }: session_status is active, saved, lost, taken_over, not_started or no_react_runtime, and note says what to do next.`,
    zodSchema,
    readOnly: true,
    interaction: {
      startedMsg: () => "Checking React profiler",
      completedMsg: ({ result }) =>
        result.is_running ? "React profiler is running" : "React profiler is stopped",
      failedMsg: ({ failureSignal }) =>
        `Failed to check React profiler: ${failureSignal.error_code}`,
    },
    // RN-only: companion to react-profiler-start.
    capability: REACT_PROFILER_TOOL_CAPABILITY,
    services: () => ({}),
    async execute(_services, params): Promise<StatusResponse> {
      // Same key as react-profiler-start/stop, so a forwarded logicalDeviceId
      // reads the run they keep, not a second session.
      const port = metroPort(params);
      const deviceId = canonicalDeviceId(params.device_id) ?? params.device_id;
      const psUrn = `${REACT_PROFILER_SESSION_NAMESPACE}:${port}:${deviceId}`;

      // This tool-server's own record of the last run, which outlives the
      // session node a stop, reload or teardown disposes.
      const saved = getCachedProfilerPaths(port, deviceId);
      const lost = getLostProfilerRun(port, deviceId);
      const lastRun = {
        ...(saved ? { saved_session: savedSessionInfo(saved) } : {}),
        ...(lost ? { lost_run: lostRunInfo(lost) } : {}),
      };
      const withLastRun = (note: string): string => {
        const text = lastRunText(saved, lost);
        return text ? `${note} ${text}` : note;
      };

      const noRuntime = (note: string): StatusResponse => ({
        hook_exists: false,
        renderer_interface_found: false,
        is_running: false,
        current_session_id: null,
        current_owner: null,
        session_status: "no_react_runtime",
        note: withLastRun(note),
        ...lastRun,
      });

      let api: ReactProfilerSessionApi;
      try {
        api = await registry.resolveService<ReactProfilerSessionApi>(psUrn);
      } catch {
        return noRuntime(
          "Unable to resolve a React profiler session — the Hermes runtime may not be reachable. Reconnect the debugger and retry."
        );
      }

      // Answers without the app, which may be busy with the stop and not reply.
      const stopInProgress = (): StatusResponse => ({
        hook_exists: true,
        renderer_interface_found: true,
        is_running: true,
        current_session_id: api.sessionId,
        current_owner: null,
        session_status: "active",
        note: STOP_IN_PROGRESS_NOTE,
      });
      if (api.stopping) return stopInProgress();

      const cdp = api.cdp;
      if (!cdp.isConnected()) {
        return noRuntime(
          "CDP connection is not available — the debugger may be disconnected or the app isn't a dev build."
        );
      }

      // Idempotent.
      try {
        await cdp.evaluate(REACT_NATIVE_PROFILER_SETUP_SCRIPT);
      } catch {
        /* best-effort */
      }

      let stateJson: string | undefined;
      try {
        stateJson = (await cdp.evaluate(READ_STATE_SCRIPT)) as string | undefined;
      } catch {
        return noRuntime(
          "Failed to evaluate state script on the Hermes runtime. The debugger may have been disconnected."
        );
      }
      if (!stateJson) {
        return noRuntime(
          "No value returned while reading React profiler state. The Hermes runtime may be unavailable."
        );
      }

      const state = JSON.parse(stateJson) as ReadStateResult;

      // A stop that began during the reads above reads as one that failed.
      if (api.stopping) return stopInProgress();

      if (!state.hookExists) {
        return noRuntime(
          "React DevTools hook not attached — debugger may be disconnected or the app isn't a dev build."
        );
      }

      if (!("rendererInterfaceFound" in state) || !state.rendererInterfaceFound) {
        return {
          ...noRuntime(
            "No React renderer attached yet — the app hasn't rendered its first commit."
          ),
          hook_exists: true,
        };
      }

      const owner = state.owner;
      const inApp = {
        hook_exists: true,
        renderer_interface_found: true,
        is_running: state.isRunning,
        current_session_id: owner?.sessionId ?? null,
        current_owner: owner,
      };

      // The run this session node started, if any. `sessionId` outlives
      // `profilingActive` only when a stop or start failed partway: a
      // successful stop clears both and disposes the node.
      const ownRunId = api.sessionId;
      const recordingHere = api.profilingActive && ownRunId !== null;

      const lostResponse = (
        sessionId: string | null,
        cause: LiveLostRunCause,
        stillRecording: boolean
      ): StatusResponse => ({
        ...inApp,
        session_status: "lost",
        note:
          `Your run${sessionId ? ` (session ${sessionId})` : ""} was not saved: ${lostRunCauseText(cause)}. ` +
          (stillRecording
            ? "The app is still recording it, but react-profiler-stop can no longer collect it. Call react-profiler-start: it stops that recording and starts a new run, no force needed."
            : cause === "ended_in_app"
              ? "Call react-profiler-stop to collect it. A react-profiler-start would discard it."
              : "Call react-profiler-start to record again."),
        ...lastRun,
        lost_run: { session_id: sessionId, cause },
      });

      if (state.isRunning) {
        if (owner && ownRunId !== null && owner.sessionId === ownRunId) {
          if (recordingHere) {
            // From the state read above: the heartbeat below would hide a stale run.
            const { stale, heartbeatAgeSeconds } = classifyStaleness({
              owner,
              nowEpochMs: state.nowEpochMs,
            });
            // Keep the run fresh for anyone deciding whether it is stale.
            await cdp.evaluate(buildHeartbeatScript(ownRunId)).catch(() => {});
            return {
              ...inApp,
              session_status: "active",
              stale,
              heartbeat_age_seconds: heartbeatAgeSeconds,
              note: stale
                ? STALE_OWN_RUN_NOTE
                : "A profiling session started through this tool-server is still running: yours, unless another agent shares this tool-server. Call react-profiler-stop to collect the data, or continue profiling.",
            };
          }
          return lostResponse(ownRunId, "stop_failed", true);
        }

        if (owner && lost && lost.sessionId === owner.sessionId) {
          // This tool-server lost track of the run, but the app never stopped it.
          return {
            ...inApp,
            session_status: "lost",
            note:
              `Your run (session ${owner.sessionId}) was not saved: ${lostRunCauseText(lost.cause, lost.takenOverBy)}. ` +
              "The app is still recording it, but react-profiler-stop can no longer collect it. Call react-profiler-start: it stops that recording and starts a new run, no force needed.",
            ...lastRun,
          };
        }

        // This tool-server's run, if another session replaced it.
        const yoursReplaced = recordingHere || lost?.cause === "taken_over";
        const yourRunId = ownRunId ?? lost?.sessionId ?? null;
        if (!owner) {
          return {
            ...inApp,
            session_status: "taken_over",
            note: withLastRun(
              (yoursReplaced
                ? "Your run was replaced: a profiling session is running in the app, but its ownership is unattributable"
                : "A profiling session is running but its ownership is unattributable") +
                " — likely started by a foreign DevTools client without our setup script, or cleared in a narrow window. Treat as lost and restart."
            ),
            ...lastRun,
          };
        }

        return {
          ...inApp,
          session_status: "taken_over",
          note: yoursReplaced
            ? `Your run${yourRunId ? ` (session ${yourRunId})` : ""} was taken over by session ${owner.sessionId}, which is still recording. Your data was discarded at the takeover. Do not stop their run; ask the user before taking over with react-profiler-start { force: true }.`
            : withLastRun(
                `Another profiling session (${owner.sessionId}) is running: another tool-server instance took over, or this tool-server restarted after react-profiler-start. ` +
                  "Data from a run it replaced is lost at the takeover moment. Use react-profiler-start { force: true } to reclaim, after asking the user if the run may be someone else's."
              ),
          ...lastRun,
        };
      }

      if (recordingHere) {
        if (takeoverOf(state, api)) {
          return {
            ...inApp,
            session_status: "taken_over",
            note:
              `Your run (session ${ownRunId}) was not saved: ${lostRunCauseText("taken_over")}. ` +
              "That session has since stopped too. Nothing is recording now; call react-profiler-start to record again.",
            ...lastRun,
            lost_run: { session_id: ownRunId, cause: "taken_over" },
          };
        }
        return lostResponse(ownRunId, "ended_in_app", false);
      }
      if (ownRunId !== null) return lostResponse(ownRunId, "stop_failed", false);

      if (lost) {
        const takenOver = lost.cause === "taken_over";
        return {
          ...inApp,
          session_status: takenOver ? "taken_over" : "lost",
          note:
            lostRunText(lost) +
            (takenOver ? " That session has since stopped too. " : " ") +
            "Nothing is recording now; call react-profiler-start to record again.",
          ...lastRun,
        };
      }

      if (saved) {
        return {
          ...inApp,
          session_status: "saved",
          note: `No profiling session is running. ${savedSessionText(saved)} A new react-profiler-start replaces it.`,
          ...lastRun,
        };
      }

      return {
        ...inApp,
        session_status: "not_started",
        note: "No profiling session is running, and this tool-server has no run on record for this device: none was started since it launched. Call react-profiler-start to begin one.",
      };
    },
  };
}
