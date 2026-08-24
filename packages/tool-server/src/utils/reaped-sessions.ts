/**
 * Process-global record of capture sessions a teardown reaped while they still
 * held data nobody had retrieved.
 *
 * `Registry._teardown` nulls the node's instance, so the next tool call
 * resolves a FRESH service indistinguishable from one that never ran — and the
 * stop tools answer "no active session, call start first" for a capture that
 * did run and whose output may still be on disk. The disposer leaves a
 * breadcrumb here instead, and the tool that would report absence reports the
 * teardown. Module-global because it has to outlive the service instance it
 * describes, which is exactly what teardown destroys.
 *
 * Entries are CONSUMED by the read ({@link takeReapedSession}) — leaving one
 * would make a genuine later "you never started a recording" blame a teardown
 * from an hour ago.
 */

/** Scopes the key, so two kinds on one device can't collide. */
export type ReapedSessionKind = "screen-recording" | "native-profiler" | "js-runtime-debugger";

export interface ReapedSession {
  kind: ReapedSessionKind;
  deviceId: string;
  /** Teardown time, for the "…N seconds ago" phrasing. */
  atMs: number;
  /**
   * What survived, as a ready-to-read clause (e.g. naming a salvaged file).
   * Built by the disposer, which is the only place that still knows.
   */
  salvage?: string;
}

const reaped = new Map<string, ReapedSession>();

function key(kind: ReapedSessionKind, deviceId: string): string {
  return `${kind}:${deviceId.toLowerCase()}`;
}

/**
 * Call ONLY when there was something to lose: a dispose of an idle session is
 * routine cleanup, and recording it would make the next honest "no active
 * session" answer claim a teardown destroyed something.
 */
export function recordReapedSession(
  kind: ReapedSessionKind,
  deviceId: string,
  salvage?: string
): void {
  const entry: ReapedSession = { kind, deviceId, atMs: Date.now() };
  if (salvage) entry.salvage = salvage;
  reaped.set(key(kind, deviceId), entry);
}

export function takeReapedSession(
  kind: ReapedSessionKind,
  deviceId: string
): ReapedSession | undefined {
  const k = key(kind, deviceId);
  const entry = reaped.get(k);
  if (entry) reaped.delete(k);
  return entry;
}

/**
 * The sentence a tool shows in place of "no active session".
 *
 * `Registry._teardown` calls a blueprint's `dispose()` with no caller, so the
 * disposer that left the breadcrumb cannot see which teardown triggered it —
 * hence a message naming the family rather than asserting one member.
 */
export function describeReapedSession(entry: ReapedSession, what: string): string {
  const secondsAgo = Math.max(0, Math.round((Date.now() - entry.atMs) / 1000));
  return (
    `The ${what} for device ${entry.deviceId} was torn down ${secondsAgo}s ago — by a ` +
    `stop-all-simulator-servers, which reaps every service a device owns, or by another ` +
    `teardown that reaches the same services (a stop-simulator-server on Chromium, or a ` +
    `react-profiler-start reclaiming the session with force). One tool-server serves every ` +
    `agent using this argent install, so this may have been another agent rather than your own ` +
    `call. It was not a session that never started.` +
    (entry.salvage ? ` ${entry.salvage}` : "")
  );
}

/** Test-only: the map is module-global and would otherwise leak across cases. */
export function __resetReapedSessionsForTesting(): void {
  reaped.clear();
}
