// Opt-out telemetry for Argent. Public functions swallow telemetry
// failures and surface diagnostics only when ARGENT_TELEMETRY_DEBUG=1.

import {
  getClient,
  getConstructedClient,
  resetClient,
  OTLP_LOGS_ENDPOINT,
  resolveConfig,
  type TelemetryClient,
} from "./otel.js";
import { sanitize } from "./sanitize.js";
import { getBaseProps, type Runtime } from "./base-props.js";
import {
  readOrCreateAnonId,
  scheduleFingerprintUpgrade,
  warmIdentity,
  warmIdentitySync,
  peekAnonId,
} from "./identity.js";
import { resolveHostFingerprint, resolveHostFingerprintAsync } from "./fingerprint.js";
import { isEnabled, writeConsentFlag, getConsentState } from "./consent.js";
import { emitDebugError, emitDebugPayload, isDebugEnabled } from "./debug.js";
import type { EventName, EventPropertyMap } from "./events.js";

export type {
  DebuggerNotConnectedReason,
  DebuggerToolOutcome,
  EventName,
  EventPropertyMap,
  Platform,
} from "./events.js";
export { DEBUGGER_NOT_CONNECTED_REASONS, DEBUGGER_TOOL_OUTCOMES, PLATFORMS } from "./events.js";
export type { Runtime } from "./base-props.js";
export type { TelemetryResetResult } from "./uninstall-reset.js";
export { resetLocalTelemetryState } from "./uninstall-reset.js";
export type { ConsentState, ConsentSource } from "./consent.js";
export { attachRegistryTelemetry } from "./registry-listener.js";
export { _resetConsentCacheForTest } from "./consent.js";
export { EVENT_NAMES } from "./events.js";
export { describeCrash } from "./crash-diagnostics.js";
export type { CrashDiagnostics, CrashPhase } from "./crash-diagnostics.js";
export { isDebugEnabled } from "./debug.js";
// Not telemetry-specific, but this is where the ci-info detector lives: the
// CLI uses it to tailor guidance for a run nobody is watching.
export { isCi } from "./ci-detect.js";
export { getConsentState, isEnabled } from "./consent.js";
// Persists the consent flag — for recording an initial first-run choice. Use
// markDisabled() (not this) for a live opt-out that should also drain and reset
// the running client.
export { writeConsentFlag } from "./consent.js";
// Applies a first-run choice to the current session only (in-process, not on
// disk), so an interactive consent prompt can govern this run's events before
// the decision is committed at install completion.
export { setSessionConsentOverride } from "./consent.js";
export {
  FIRST_RUN_NOTICE,
  FIRST_RUN_NOTICE_BODY_LINES,
  TELEMETRY_OPT_OUT_COMMAND,
  TELEMETRY_DETAILS_URL,
  hasShownFirstRunNotice,
  markFirstRunNoticeShown,
  resetFirstRunNotice,
  shouldShowFirstRunNotice,
} from "./notice.js";
export { getSessionId } from "./base-props.js";
export {
  AI_CLIENTS,
  canonicalizeAiClient,
  aiTelemetryFromMeta,
  type AiClient,
  type AiTelemetryProps,
} from "./ai-identity.js";

const SHORT_FLUSH_TIMEOUT_MS = 1_500;

interface RuntimeState {
  runtime: Runtime;
  initialized: boolean;
}

let state: RuntimeState | null = null;

export function init(runtime: Runtime): void {
  if (state && state.runtime === runtime) return;
  state = {
    runtime,
    initialized: true,
  };
}

function activeRuntime(): Runtime {
  return state?.runtime ?? "cli";
}

/**
 * Establish the telemetry identity OFF the hot path, for a long-lived entry
 * point (the tool-server) that must not pay a blocking fingerprint resolve on
 * its request-accept path.
 *
 * Resolves the fingerprint asynchronously and persists it (or a fallback) before
 * the caller advertises readiness, so the first tracked event and all inbound
 * requests find the id already on disk — never triggering a synchronous spawn in
 * `track()`'s accept-path callback. Respects consent: a disabled machine mints
 * no identity. Best-effort — never throws.
 */
export async function warmTelemetryIdentity(): Promise<void> {
  try {
    if (!isEnabled()) return;
    // Mirror track()/buildPayload, which resolve the client before provisioning
    // the id: there is no reason to spawn the fingerprint binary and write a
    // durable per-machine id for events that can never be transmitted (no usable
    // ingest token). Unreachable in the shipped build (the bundled token is
    // usable), but reachable in the emergency-local / token-stripped builds that
    // resolveConfig() anticipates ("" / "otel_disabled").
    if (!getClient()) return;
    await warmIdentity(resolveHostFingerprintAsync);
  } catch (err) {
    emitDebugError("warmTelemetryIdentity failed", err);
  }
}

/**
 * Establish the telemetry identity BEFORE the first tracked event, for a
 * SHORT-LIVED entry point (the installer CLI: `argent init` / `argent update`).
 *
 * The async warmTelemetryIdentity() is UNSAFE here: it awaits
 * resolveHostFingerprintAsync, whose child/stdout/watchdog are unref'd so a
 * background probe never holds a CLI open — awaited as the only pending work in a
 * short-lived process, that promise never settles and the process exits. This
 * variant resolves the fingerprint SYNCHRONOUSLY (bounded execFileSync) and
 * migrates any legacy/fresh fallback id to it, so the very first event carries
 * the stable per-machine distinct_id instead of a fallback the background upgrade
 * would only migrate to afterward (splitting the machine across two ids).
 *
 * Blocks briefly (a fast cached/disk read on a warm machine; a bounded one-time
 * spawn on a cold/fresh one) — acceptable for a CLI about to do far slower work.
 * Respects consent (a disabled machine mints no identity) and never throws.
 */
export function warmTelemetryIdentitySync(): void {
  try {
    if (!isEnabled()) return;
    // Mirror warmTelemetryIdentity/track: don't provision a durable id for events
    // that can never be transmitted (no usable ingest token).
    if (!getClient()) return;
    warmIdentitySync(resolveHostFingerprint);
  } catch (err) {
    emitDebugError("warmTelemetryIdentitySync failed", err);
  }
}

function buildPayload(
  event: string,
  props: Record<string, unknown>
): {
  distinctId: string;
  properties: Record<string, unknown>;
} | null {
  // Lazy id creation: only on the first event we send. resolveHostFingerprint
  // is the single shared resolution point for every entry point (installer,
  // CLI, tool-server, MCP), so the distinct_id is a stable per-machine id
  // everywhere — not only when the tool-server runs. The sync resolve here
  // blocks only on the truly-fresh path (nothing on disk); a fallback id already
  // on disk is served immediately and upgraded off the hot path below.
  let distinctId: string;
  try {
    distinctId = readOrCreateAnonId(resolveHostFingerprint);
  } catch (err) {
    emitDebugError("buildPayload: identity creation failed", err);
    return null;
  }

  // If we are emitting under a fallback id (the fingerprint wasn't resolved
  // synchronously), converge on the deterministic fingerprint in the background
  // — non-blocking, bounded, and self-healing for a long-lived process that
  // started before the binary was warm. No-op once the fingerprint is
  // established. Never throws.
  scheduleFingerprintUpgrade(resolveHostFingerprintAsync);

  const base = getBaseProps(activeRuntime());
  const sanitized = sanitize(event, props);
  const properties = { ...base, ...sanitized };
  return { distinctId, properties };
}

/**
 * Enqueue a telemetry event on the shared OpenTelemetry logs client.
 *
 * This does not force a network send: the event is handed to the batch log-record
 * processor and exported on its schedule. Short-lived commands must call
 * shutdown() before process exit; shutdown() force-flushes the batch and drains
 * the queue with a bounded timeout.
 */
export function track<E extends EventName>(event: E, props: EventPropertyMap[E]): void {
  try {
    if (!isEnabled()) return;
    // Resolve the client before buildPayload(): buildPayload creates/persists
    // the anon-id file, and there's no reason to provision a persistent
    // identifier on disk for an event that can never be transmitted (no usable
    // ingest token).
    const client = getClient();
    if (!client) return;

    const built = buildPayload(event, props as Record<string, unknown>);
    if (!built) return;

    if (isDebugEnabled()) {
      emitDebugPayload({
        event,
        distinctId: built.distinctId,
        properties: built.properties,
        ts: new Date().toISOString(),
      });
    }

    try {
      client.emit({
        distinctId: built.distinctId,
        event,
        properties: built.properties,
      });
    } catch (err) {
      emitDebugError(`track: emit(${event}) failed`, err);
    }
  } catch (err) {
    emitDebugError(`track: outer wrapper caught ${event}`, err);
  }
}

/**
 * Slack between the export deadline and the race that abandons it.
 *
 * The exporter's own EXPORT_TIMEOUT_MS equals this budget, so a race armed at
 * exactly timeoutMs fires the same instant the export would give up — the batch
 * is always abandoned rather than allowed to finish failing. Every drain waits
 * this much longer than the deadline it is bounding, so the inner one wins.
 */
const DRAIN_GRACE_MS = 250;

/**
 * Race a client drain against its budget, so no caller waits on the exporter
 * indefinitely. Shared by shutdown() and markDisabled() so the two cannot drift
 * apart on the grace period.
 */
async function raceDrain(client: TelemetryClient, timeoutMs: number): Promise<void> {
  await Promise.race([
    client.shutdown(timeoutMs),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + DRAIN_GRACE_MS).unref()),
  ]);
}

/**
 * Drain queued telemetry and reset the shared client.
 *
 * The OpenTelemetry batch log-record processor buffers events and exports them on
 * a timer. Call shutdown() at command boundaries so the buffered batch is
 * force-flushed and the exporter is torn down before the process exits.
 *
 * Resolving is not quite the same as the process being free to exit: an export
 * still in flight holds a ref'd socket, and the exporter's retry backoff a ref'd
 * timer. The batch timer is not one of them — the SDK unrefs that, which is also
 * why an event emitted and never drained is simply dropped at exit rather than
 * delaying it. Both of the ref'd ones are bounded by the exporter's own deadline,
 * which otel.ts holds at or below this budget and pairs with a socket timeout
 * that covers connection establishment, so a collector that refuses or blackholes
 * costs milliseconds past this race rather than the OS connect timeout.
 */
export async function shutdown(timeoutMs = SHORT_FLUSH_TIMEOUT_MS): Promise<void> {
  const client = getConstructedClient();
  if (!client) {
    state = null;
    return;
  }
  try {
    await raceDrain(client, timeoutMs);
  } catch (err) {
    emitDebugError("shutdown failed", err);
  } finally {
    resetClient();
    state = null;
  }
}

/** Persist `enabled=true`. */
export function markEnabled(): void {
  writeConsentFlag(true);
}

// Disable persists the opt-out flag, then drains any already-queued events and
// resets the running client.
export async function markDisabled(): Promise<void> {
  try {
    // Drain only a client that already exists; opting out must never construct
    // one (and thereby mint a durable anon-id) on a machine that has never sent
    // anything.
    const client = getConstructedClient();
    writeConsentFlag(false);
    if (client) {
      try {
        await raceDrain(client, SHORT_FLUSH_TIMEOUT_MS);
      } catch {
        /* swallow */
      }
    }
    // Next track() will short-circuit on the persisted opt-out.
    resetClient();
    state = null;
  } catch (err) {
    emitDebugError("markDisabled failed", err);
  }
}

/** Status payload for `argent telemetry status`; does not create a client. */
export function status(): {
  enabled: boolean;
  source: ReturnType<typeof getConsentState>["source"];
  anonIdPrefix: string | null;
  hasAnonIdOnDisk: boolean;
  host: string;
  isKeyConfigured: boolean;
} {
  const consent = getConsentState();

  // Read the id without creating one; status must be side-effect free.
  const anonId = peekAnonId();
  const hasAnonIdOnDisk = anonId !== null;
  const anonIdPrefix = anonId ? anonId.slice(0, 8) : null;

  const config = resolveConfig();
  return {
    enabled: consent.enabled,
    source: consent.source,
    anonIdPrefix,
    hasAnonIdOnDisk,
    host: OTLP_LOGS_ENDPOINT,
    isKeyConfigured: config.isUsable,
  };
}
