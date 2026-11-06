/**
 * Wording shared by react-profiler-status and react-profiler-stop for how this
 * tool-server's last run on a device ended: saved, or lost and why.
 */
import type {
  LostProfilerRun,
  LostProfilerRunCause,
  ProfilerSessionPaths,
} from "../../blueprints/react-profiler-session";

/** Losses read from the live session rather than from the lost-run record. */
export type LiveLostRunCause = "stop_failed" | "ended_in_app";

export interface SavedSessionInfo {
  session_id: string;
  commits_path: string | null;
  cpu_profile_path: string | null;
  loaded_from_disk?: boolean;
}

export interface LostRunInfo {
  session_id: string | null;
  cause: LostProfilerRunCause | LiveLostRunCause;
  lost_at?: string;
  taken_over_by?: string | null;
}

export function savedSessionInfo(paths: ProfilerSessionPaths): SavedSessionInfo {
  return {
    session_id: paths.sessionId,
    commits_path: paths.commitsPath,
    cpu_profile_path: paths.cpuProfilePath,
    ...(paths.loadedFromDisk ? { loaded_from_disk: true } : {}),
  };
}

export function lostRunInfo(run: LostProfilerRun): LostRunInfo {
  return {
    session_id: run.sessionId,
    cause: run.cause,
    lost_at: new Date(run.lostAtEpochMs).toISOString(),
    ...(run.takenOverBy !== undefined ? { taken_over_by: run.takenOverBy } : {}),
  };
}

/** What ended the run, as a clause: "a JS reload (…) ended it". */
export function lostRunCauseText(
  cause: LostProfilerRunCause | LiveLostRunCause,
  takenOverBy?: string | null
): string {
  switch (cause) {
    case "js_reload":
      return "a JS reload (Metro's `r`, a red-box Reload, debugger-reload-metro) ended it";
    case "cdp_disconnected":
      return (
        "the debugger connection dropped while it was recording: the app crashed or was killed, " +
        "Metro restarted, or another debugger took the connection"
      );
    case "session_torn_down":
      return (
        "its session was torn down mid-run, typically by stop-all-simulator-servers: the run " +
        "rides on the device's JS-runtime debugger, which that teardown reaps, and one " +
        "tool-server serves every agent using this argent install"
      );
    case "taken_over":
      return takenOverBy
        ? `session ${takenOverBy} took it over, which discarded its data`
        : "another session took it over, which discarded its data";
    case "stop_failed":
      return (
        "a react-profiler-stop, or a react-profiler-start that replaced it, failed partway " +
        "(see the error it returned; if that react-profiler-stop is still running, wait for its result)"
      );
    case "ended_in_app":
      return (
        "it stopped recording in the app without a react-profiler-stop: a JS reload, another " +
        "session that took it over and has since stopped, or React profiling stopped outside argent"
      );
  }
}

export function savedSessionText(paths: ProfilerSessionPaths): string {
  if (paths.loadedFromDisk) {
    return (
      `Session ${paths.sessionId} is loaded from disk: react-profiler-analyze and the profiler ` +
      `query tools read it.`
    );
  }
  return (
    `Your last run was stopped and saved as session ${paths.sessionId}: react-profiler-analyze ` +
    `and the profiler query tools read it. After a tool-server restart, load it again with ` +
    `profiler-load { mode: "load_react", session_id: "${paths.sessionId}" }.`
  );
}

export function lostRunText(lost: LostProfilerRun): string {
  const which = lost.sessionId ? `Your last run (session ${lost.sessionId})` : "Your last run";
  return `${which} was not saved: ${lostRunCauseText(lost.cause, lost.takenOverBy)}.`;
}

/**
 * One sentence on this tool-server's last run on the device, or null when it
 * has no record of one. When both records exist, the loss is the last run: a
 * saved run drops the lost-run record, a start clears both, and what is left
 * beside a loss can only be a session loaded from disk.
 */
export function lastRunText(
  saved: ProfilerSessionPaths | undefined,
  lost: LostProfilerRun | undefined
): string | null {
  if (lost) return lostRunText(lost);
  if (saved) return savedSessionText(saved);
  return null;
}
