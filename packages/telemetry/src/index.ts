// Opt-out telemetry for Argent. Public functions swallow telemetry
// failures and surface diagnostics only when ARGENT_TELEMETRY_DEBUG=1.

import {
  getClient,
  getConstructedClient,
  resetClient,
  POSTHOG_HOST,
  resolveConfig,
} from "./posthog.js";
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

export type { EventName, EventPropertyMap } from "./events.js";
export type { Runtime } from "./base-props.js";
export type { TelemetryResetResult } from "./uninstall-reset.js";
export { resetLocalTelemetryState } from "./uninstall-reset.js";
export type { ConsentState, ConsentSource } from "./consent.js";
export { attachRegistryTelemetry } from "./registry-listener.js";
export { POSTHOG_HOST, resolveConfig } from "./posthog.js";
export { _resetConsentCacheForTest } from "./consent.js";
export { EVENT_NAMES } from "./events.js";
export { isDebugEnabled } from "./debug.js";
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
    // PostHog key). Unreachable in the shipped build (the bundled token is
    // usable), but reachable in the emergency-local / token-stripped builds that
    // resolveConfig() anticipates ("" / "phc_disabled").
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
    // that can never be transmitted (no usable PostHog key).
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
 * Enqueue a telemetry event on the shared PostHog client.
 *
 * This does not force a network send. Short-lived commands must call
 * shutdown() before process exit; shutdown() waits for PostHog's async capture
 * preparation and drains the queue with a bounded timeout.
 */
export function track<E extends EventName>(event: E, props: EventPropertyMap[E]): void {
  try {
    if (!isEnabled()) return;
    // Resolve the client before buildPayload(): buildPayload creates/persists
    // the anon-id file, and there's no reason to provision a persistent
    // identifier on disk for an event that can never be transmitted (no usable
    // PostHog key).
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
      client.capture({
        distinctId: built.distinctId,
        event,
        properties: built.properties,
      });
    } catch (err) {
      emitDebugError(`track: capture(${event}) failed`, err);
    }
  } catch (err) {
    emitDebugError(`track: outer wrapper caught ${event}`, err);
  }
}

/**
 * Drain queued telemetry and reset the shared client.
 *
 * PostHog capture() performs async event preparation before queueing. Use
 * shutdown(), not flush(), at command boundaries so pending capture work is
 * joined before the queue is flushed.
 */
export async function shutdown(timeoutMs = SHORT_FLUSH_TIMEOUT_MS): Promise<void> {
  const client = getConstructedClient();
  if (!client) {
    state = null;
    return;
  }
  try {
    await Promise.race([
      client.shutdown(timeoutMs),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 250).unref()),
    ]);
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
        await Promise.race([
          client.shutdown(SHORT_FLUSH_TIMEOUT_MS),
          new Promise<void>((resolve) => setTimeout(resolve, SHORT_FLUSH_TIMEOUT_MS).unref()),
        ]);
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
    host: POSTHOG_HOST,
    isKeyConfigured: config.isUsable,
  };
}
