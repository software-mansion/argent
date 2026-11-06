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

interface StalenessInput {
  owner: ProfilerSessionOwner | null;
  nowEpochMs: number;
  staleThresholdMs?: number;
}

interface StalenessResult {
  stale: boolean;
  ageSeconds: number | null;
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
      canReclaimWithoutForce: true,
    };
  }

  const ageMs = nowEpochMs - owner.startedAtEpochMs;
  const heartbeatAgeMs = nowEpochMs - owner.lastHeartbeatEpochMs;
  const stale = heartbeatAgeMs > staleThresholdMs;

  return {
    stale,
    ageSeconds: Math.max(0, ageMs) / 1000,
    canReclaimWithoutForce: stale,
  };
}

/** The part of READ_STATE_SCRIPT's result that says who has the app's recording. */
interface AppRecordingState {
  isRunning?: boolean;
  owner?: ProfilerSessionOwner | null;
}

/** The run a takeover is checked for; ReactProfilerSessionApi has this field. */
interface OwnRun {
  sessionId: string | null;
}

/**
 * The session that started a run over `run`, as `by`, which is null when the
 * recording has no owner record.
 */
export function takeoverOf(
  state: AppRecordingState,
  run: OwnRun
): { by: string | null } | undefined {
  if (run.sessionId === null || !state.isRunning) return undefined;
  if (state.owner?.sessionId === run.sessionId) return undefined;
  return { by: state.owner?.sessionId ?? null };
}

/** `takeoverOf` on the app's current state; undefined when that cannot be read. */
export async function readTakeover(
  cdp: Pick<CDPClient, "evaluate">,
  run: OwnRun
): Promise<{ by: string | null } | undefined> {
  try {
    const raw = (await cdp.evaluate(READ_STATE_SCRIPT)) as string | undefined;
    return raw ? takeoverOf(JSON.parse(raw) as AppRecordingState, run) : undefined;
  } catch {
    return undefined;
  }
}
