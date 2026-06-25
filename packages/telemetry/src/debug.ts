import * as fs from "node:fs";
import { argentHomeDir, debugLogPath } from "./paths.js";

// ARGENT_TELEMETRY_DEBUG=1 mirrors sanitized payloads and SDK errors locally.
export function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ARGENT_TELEMETRY_DEBUG;
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes" || norm === "on";
}

export interface DebugPayload {
  event: string;
  distinctId: string;
  properties: Record<string, unknown>;
  ts: string;
}

export function emitDebugPayload(payload: DebugPayload): void {
  if (!isDebugEnabled()) return;

  let line: string;
  try {
    line = JSON.stringify(payload);
  } catch (err) {
    const reason = err instanceof Error ? err.constructor.name : "Error";
    line = JSON.stringify({
      event: payload.event,
      distinctId: payload.distinctId,
      properties: { debug_payload_serialization_error: reason },
      ts: payload.ts,
    });
  }
  try {
    process.stderr.write(`[argent-telemetry] ${line}\n`);
  } catch {
    /* stderr can EPIPE in piped contexts */
  }
  try {
    fs.mkdirSync(argentHomeDir(), { recursive: true });
    fs.appendFileSync(debugLogPath(), line + "\n");
  } catch {
    /* best-effort */
  }
}

export function emitDebugError(prefix: string, err: unknown): void {
  if (!isDebugEnabled()) return;
  const msg = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
  try {
    process.stderr.write(`[argent-telemetry] ${prefix}: ${msg}\n`);
  } catch {
    /* nothing to do */
  }
}
