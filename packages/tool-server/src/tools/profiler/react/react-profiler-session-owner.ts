/**
 * Pure helpers for React profiler session ownership.
 *
 * Kept separate from the tool files so they can be unit-tested without CDP /
 * vitest mocking. See `argent-react-profiler-session-plan.md` §§5–7.
 */

export interface ProfilerSessionOwner {
  sessionId: string;
  startedAtEpochMs: number;
  lastHeartbeatEpochMs: number;
  toolServerPid: number;
  toolServerStartedAtEpochMs: number;
  toolName: string;
  startArgs: Record<string, unknown>;
  commitCountAtStart: number;
}

/**
 * The `ProfilingDataBackend` shape returned by `ri.getProfilingData()` —
 * we only model the bits we actually touch on the merge path.
 */
export interface BackendCommitData {
  timestamp: number; // ms since the `startProfiling` call (verified P1)
  priorityLevel?: string;
  duration?: number;
  effectDuration?: number;
  passiveEffectDuration?: number;
  fiberActualDurations?: Array<[number, number]>;
  fiberSelfDurations?: Array<[number, number]>;
  changeDescriptions?: Array<[number, unknown]>;
}

export interface BackendRootData {
  rootID: number;
  commitData: BackendCommitData[];
  initialTreeBaseDurations?: Array<[number, number]>;
}

export interface ProfilingDataBackend {
  dataForRoots: BackendRootData[];
  rendererID?: number;
  timelineData?: unknown;
}

/**
 * Merge live backend data with a snapshot rescued by the Strategy-A wrapper.
 *
 * Precedence: live > PREV. Live is the currently-returned `getProfilingData()`
 * result; PREV is `globalThis.__ARGENT_PREV_PROFILE__`, captured before any
 * wipe-causing `startProfiling` call.
 *
 * "Prefer live" means: if a rootID appears in both, the live roots wins
 * verbatim. Roots that exist only in PREV are appended. This matches the
 * expected recovery semantic — a live buffer always reflects *our* current
 * session; PREV is only a fallback for concurrent-wipe scenarios.
 */
export function mergeProfilingData(
  live: ProfilingDataBackend | null,
  prev: ProfilingDataBackend | null
): ProfilingDataBackend {
  const roots: BackendRootData[] = [];
  const seen = new Set<number>();

  if (live?.dataForRoots) {
    for (const r of live.dataForRoots) {
      roots.push(r);
      seen.add(r.rootID);
    }
  }
  if (prev?.dataForRoots) {
    for (const r of prev.dataForRoots) {
      if (!seen.has(r.rootID)) {
        roots.push(r);
        seen.add(r.rootID);
      }
    }
  }

  return {
    dataForRoots: roots,
    rendererID: live?.rendererID ?? prev?.rendererID,
    timelineData: live?.timelineData ?? prev?.timelineData,
  };
}

export const DEFAULT_STALE_THRESHOLD_MS = 5 * 60_000;

export interface StalenessInput {
  owner: ProfilerSessionOwner | null;
  nowEpochMs: number;
  staleThresholdMs?: number;
}

export interface StalenessResult {
  stale: boolean;
  ageSeconds: number | null;
  canReclaimWithoutForce: boolean;
}

/**
 * Classify an active profiling session as fresh / stale / reclaimable.
 *
 * - No owner metadata → takeover is safe (previous tool-server died mid-session,
 *   or the session was started by a foreign DevTools client).
 * - `stale = true` when the owner's `lastHeartbeatEpochMs` is older than
 *   `staleThresholdMs`. Takeover is safe without `force`.
 * - Otherwise the caller must pass `{ force: true }` to reclaim.
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
