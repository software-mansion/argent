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
}

export const DEFAULT_STALE_THRESHOLD_MS = 5 * 60_000;

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
