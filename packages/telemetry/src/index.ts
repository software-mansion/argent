// Anonymous opt-out telemetry for Argent. Public functions swallow telemetry
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
import { readOrCreateAnonId, peekAnonId } from "./identity.js";
import { isEnabled as consentIsEnabled, writeConsentFlag, getConsentState } from "./consent.js";
import { emitDebugError, emitDebugPayload, isDebugEnabled } from "./debug.js";
import { forget as forgetImpl, type ForgetOptions, type ForgetResult } from "./erasure.js";
import type { EventName, EventPropertyMap } from "./events.js";

export type { EventName, EventPropertyMap } from "./events.js";
export type { Runtime } from "./base-props.js";
export type { ForgetOptions, ForgetResult } from "./erasure.js";
export type { ConsentState, ConsentSource } from "./consent.js";
export { attachRegistryTelemetry } from "./registry-listener.js";
export { POSTHOG_HOST, resolveConfig } from "./posthog.js";
export { _resetConsentCacheForTest } from "./consent.js";
export { EVENT_NAMES } from "./events.js";
export { isDebugEnabled } from "./debug.js";
export { getConsentState } from "./consent.js";
// Persists the consent flag without emitting a transition event — for recording
// an initial first-run choice. Use markDisabled() (not this) for a live opt-out
// that should send a final telemetry:opt_out before the pipe closes.
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
  AI_CLIENT_NAME_PATTERN,
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

function buildPayload(
  event: string,
  props: Record<string, unknown>
): {
  distinctId: string;
  properties: Record<string, unknown>;
} | null {
  // Lazy id creation: only on the first event we send.
  let distinctId: string;
  try {
    distinctId = readOrCreateAnonId();
  } catch (err) {
    emitDebugError("buildPayload: identity creation failed", err);
    return null;
  }

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
    if (!consentIsEnabled()) return;
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

export function isEnabled(): boolean {
  return consentIsEnabled();
}

/** Persist `enabled=true`. */
export function markEnabled(): void {
  writeConsentFlag(true);
}

// Disable records one final opt-out event, persists the flag, then drains.
export async function markDisabled(): Promise<void> {
  try {
    const wasEnabled = consentIsEnabled();
    let client = getConstructedClient();
    if (wasEnabled) {
      const built = buildPayload("telemetry:opt_out", {});
      if (built && isDebugEnabled()) {
        emitDebugPayload({
          event: "telemetry:opt_out",
          distinctId: built.distinctId,
          properties: built.properties,
          ts: new Date().toISOString(),
        });
      }
      client = getClient();
      if (built && client) {
        try {
          client.capture({
            distinctId: built.distinctId,
            event: "telemetry:opt_out",
            properties: built.properties,
          });
        } catch (err) {
          emitDebugError("markDisabled: capture(telemetry:opt_out) failed", err);
        }
      }
    }
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

export async function forget(options?: ForgetOptions): Promise<ForgetResult> {
  return forgetImpl(options);
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
