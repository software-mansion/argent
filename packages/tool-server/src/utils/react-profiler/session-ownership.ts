/**
 * Kept separate from the tool files so these helpers can be unit-tested without
 * CDP mocking.
 */
import type { CDPClient } from "../debugger/cdp-client";
import { READ_STATE_SCRIPT } from "./scripts";

export interface ProfilerSessionOwner {
  sessionId: string;
  startedAtEpochMs: number;
  lastHeartbeatEpochMs: number;
}

export const DEFAULT_STALE_THRESHOLD_MS = 5 * 60_000;

/** react-profiler-start and react-profiler-status, while a stop collects the run. */
export const STOP_IN_PROGRESS_NOTE =
  "A react-profiler-stop is collecting this run. Wait for its result before you call " +
  "react-profiler-start or react-profiler-stop.";

/**
 * A tool-server has no agent identity, so a stale run of its own can be another
 * agent's, or left over from an earlier conversation.
 */
export const STALE_OWN_RUN_NOTE =
  "This recording was started through this tool-server, but its heartbeat is stale, so it may " +
  "be left over from another agent or an earlier conversation. If you started it, call " +
  "react-profiler-stop to collect it. If not, ask the user before you discard it with " +
  "react-profiler-start { force: true }.";

interface StalenessInput {
  owner: ProfilerSessionOwner | null;
  nowEpochMs: number;
  staleThresholdMs?: number;
}

interface StalenessResult {
  stale: boolean;
  ageSeconds: number | null;
  heartbeatAgeSeconds: number | null;
  canReclaimWithoutForce: boolean;
}

/**
 * Missing owner metadata means the session is unattributable (e.g. a foreign
 * DevTools client), so takeover is safe. A fresh owner can only be reclaimed by
 * a caller passing `force`.
 */

export function classifyStaleness({
  owner,
  nowEpochMs,
  staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
}: StalenessInput): StalenessResult {
  if (!owner) {
    return {
      stale: false,
      ageSeconds: null,
      heartbeatAgeSeconds: null,
      canReclaimWithoutForce: true,
    };
  }

  const ageMs = nowEpochMs - owner.startedAtEpochMs;
  const heartbeatAgeMs = nowEpochMs - owner.lastHeartbeatEpochMs;
  const stale = heartbeatAgeMs > staleThresholdMs;

  return {
    stale,
    ageSeconds: Math.max(0, ageMs) / 1000,
    heartbeatAgeSeconds: Math.max(0, Math.round(heartbeatAgeMs / 1000)),
    canReclaimWithoutForce: stale,
  };
}

/** The part of READ_STATE_SCRIPT's result that says who has the app's recording. */
interface AppRecordingState {
  isRunning?: boolean;
  owner?: ProfilerSessionOwner | null;
  /** Each renderer's last start. Absent or empty when none was started here. */
  rendererStartedAtEpochMs?: number[];
}

/** The run a takeover is checked for; ReactProfilerSessionApi has these fields. */
interface OwnRun {
  sessionId: string | null;
  profileStartWallMs: number | null;
}

interface RunTakeover {
  /** The session that replaced the run, or null when the app names none. */
  by: string | null;
  stillRecording: boolean;
}

/**
 * Whether another session started a run over `run`. A stopped app names no
 * owner, but every start replaces each renderer's start time, so the run is
 * still the app's only while a renderer has the time it started with. Renderers
 * start one by one, so any of them may hold it. A stop from outside argent
 * leaves those times alone, and with none to compare there is nothing to tell.
 */
export function takeoverOf(state: AppRecordingState, run: OwnRun): RunTakeover | undefined {
  if (run.sessionId === null) return undefined;
  if (state.isRunning) {
    if (state.owner?.sessionId === run.sessionId) return undefined;
    return { by: state.owner?.sessionId ?? null, stillRecording: true };
  }
  const starts = state.rendererStartedAtEpochMs ?? [];
  if (starts.length === 0 || run.profileStartWallMs === null) return undefined;
  if (starts.includes(run.profileStartWallMs)) return undefined;
  return { by: null, stillRecording: false };
}

/** `takeoverOf` on the app's current state; undefined when that cannot be read. */
export async function readTakeover(
  cdp: Pick<CDPClient, "evaluate">,
  run: OwnRun
): Promise<RunTakeover | undefined> {
  try {
    const raw = (await cdp.evaluate(READ_STATE_SCRIPT)) as string | undefined;
    return raw ? takeoverOf(JSON.parse(raw) as AppRecordingState, run) : undefined;
  } catch {
    return undefined;
  }
}
