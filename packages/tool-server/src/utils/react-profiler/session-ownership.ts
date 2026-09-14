/**
 * Kept separate from the tool files so these helpers can be unit-tested without
 * CDP mocking.
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
