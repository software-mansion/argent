/**
 * Process-global record of capture sessions a teardown reaped while they still
 * held data nobody had retrieved.
 *
 * `stop-all-simulator-servers` disposes every device-owned service, which since
 * the `devices` scope landed includes the three that hold captured output —
 * `ScreenRecordingSession` (a video), `NativeProfilerSession` (a trace) and
 * `JsRuntimeDebugger` (a console-log file). Disposing them is deliberate: each
 * owns a spawned process or an open fd that must not outlive the session.
 *
 * What is not deliberate is what the owner is then told. `Registry._teardown`
 * nulls the node's instance, so the next tool call resolves a FRESH service
 * whose api is indistinguishable from one that never ran — and the stop tools
 * answer "no active session, call start first" for a capture that did run and
 * whose output may still be on disk. That reads as "you never started one",
 * which is the one thing that is certainly false.
 *
 * So the disposer leaves a breadcrumb here and the tool that would otherwise
 * report absence reports the teardown instead. Module-global for the same
 * reason as `screen-recording-reminder`: it has to outlive the service instance
 * it describes, which is exactly what teardown destroys.
 *
 * Entries are CONSUMED by the read ({@link takeReapedSession}) — the breadcrumb
 * explains one confusing answer, once. Leaving it would make a genuine later
 * "you never started a recording" blame a teardown from an hour ago.
 */

/** Which session kind was reaped; scopes the key so two kinds can't collide. */
export type ReapedSessionKind = "screen-recording" | "native-profiler" | "js-runtime-debugger";

export interface ReapedSession {
  kind: ReapedSessionKind;
  deviceId: string;
  /** When the teardown ran, for "…N seconds ago" phrasing. */
  atMs: number;
  /**
   * What survived, as a ready-to-read clause (e.g. naming a salvaged file), or
   * undefined when nothing did. Built by the disposer, which is the only place
   * that still knows.
   */
  salvage?: string;
}

const reaped = new Map<string, ReapedSession>();

function key(kind: ReapedSessionKind, deviceId: string): string {
  return `${kind}:${deviceId.toLowerCase()}`;
}

/**
 * Note that `kind`'s session for `deviceId` was disposed with data unretrieved.
 *
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

/** Read and consume the breadcrumb for `kind`/`deviceId`, if there is one. */
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
 * The sentence a tool shows in place of "no active session". Names what
 * happened, says it is not necessarily this agent's own doing (one tool-server
 * serves every agent), and points at whatever survived.
 *
 * The disposer that leaves a breadcrumb cannot see who triggered it — a
 * blueprint's `dispose()` is called by `Registry._teardown`, with no caller — so
 * the message names the family rather than asserting one member.
 * `stop-all-simulator-servers` is the common one and is named first, but it is
 * not the only one: `stop-simulator-server` on Chromium cascades into the
 * debugger through `ChromiumCdp` (its documented behaviour), and
 * `react-profiler-start { force: true }` disposes the debugger and the profiler
 * session to reclaim them.
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

/** Test-only: drop all breadcrumbs so cases don't leak across tests. */
export function __resetReapedSessionsForTesting(): void {
  reaped.clear();
}
