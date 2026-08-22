import * as fs from "node:fs";
import { updateConfig } from "@argent/configuration-core";
import { configFilePath } from "./paths.js";

// Consent is evaluated on every track() so a running tool server sees opt-outs.
export interface ConsentSource {
  source:
    | "env_do_not_track"
    | "env_argent_telemetry"
    | "session_override"
    | "config_file"
    | "default";
  detail?: string;
}

export interface ConsentState {
  enabled: boolean;
  source: ConsentSource;
}

interface CachedConfig {
  mtimeMs: number | null;
  fingerprint: string | null;
  enabledOverride: boolean | null;
}

const cache: { current: CachedConfig | null } = { current: null };

// In-process consent decision, never written to config.json: set while a
// first-run pick is pending commit so it governs THIS session's events.
let sessionOverride: boolean | null = null;

function readConfigOverride(): boolean | null {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(configFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache.current = { mtimeMs: null, fingerprint: null, enabledOverride: null };
      return null;
    }
    cache.current = { mtimeMs: null, fingerprint: null, enabledOverride: null };
    return null;
  }

  if (!stats.isFile()) {
    // Refuse to read symlinks / sockets / directories at that path.
    cache.current = { mtimeMs: null, fingerprint: null, enabledOverride: null };
    return null;
  }

  // Size is in the fingerprint so an edit landing in the same mtime tick still
  // busts the cache: toggling enabled true↔false always changes the byte length.
  const fingerprint = `${stats.dev}:${stats.ino}:${stats.size}`;
  const mtimeMs = stats.mtimeMs;

  if (
    cache.current &&
    cache.current.fingerprint === fingerprint &&
    cache.current.mtimeMs === mtimeMs
  ) {
    return cache.current.enabledOverride;
  }

  let parsedEnabled: boolean | null = null;
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    const json = JSON.parse(raw) as unknown;
    if (json && typeof json === "object") {
      const t = (json as Record<string, unknown>).telemetry;
      if (t && typeof t === "object") {
        const enabled = (t as Record<string, unknown>).enabled;
        if (typeof enabled === "boolean") parsedEnabled = enabled;
      }
    }
  } catch {
    // Malformed config — treat as "no override".
  }

  cache.current = { mtimeMs, fingerprint, enabledOverride: parsedEnabled };
  return parsedEnabled;
}

function parseFalsy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

function isDoNotTrackSet(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  return !parseFalsy(value);
}

/** Effective consent state; never writes to disk. */
export function getConsentState(env: NodeJS.ProcessEnv = process.env): ConsentState {
  if (isDoNotTrackSet(env.DO_NOT_TRACK)) {
    return {
      enabled: false,
      source: { source: "env_do_not_track", detail: `DO_NOT_TRACK=${env.DO_NOT_TRACK}` },
    };
  }

  const argentEnv = env.ARGENT_TELEMETRY;
  if (parseFalsy(argentEnv)) {
    return {
      enabled: false,
      source: { source: "env_argent_telemetry", detail: `ARGENT_TELEMETRY=${argentEnv}` },
    };
  }

  if (sessionOverride !== null) {
    return { enabled: sessionOverride, source: { source: "session_override" } };
  }

  const persisted = readConfigOverride();
  if (persisted === false) {
    return { enabled: false, source: { source: "config_file", detail: "config.json" } };
  }
  if (persisted === true) {
    return { enabled: true, source: { source: "config_file", detail: "config.json" } };
  }

  return { enabled: true, source: { source: "default" } };
}

export function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getConsentState(env).enabled;
}

/** Persist the telemetry flag without discarding other config keys. */
export function writeConsentFlag(enabled: boolean): void {
  updateConfig((config) => {
    const telemetryBlock =
      typeof config.telemetry === "object" && config.telemetry
        ? (config.telemetry as Record<string, unknown>)
        : {};
    config.telemetry = { ...telemetryBlock, enabled };
  });
  cache.current = null;
}

/**
 * Apply (null clears) a consent decision for this run without touching
 * config.json: `argent init` persists the pick only once setup completes, so an
 * aborted init leaves nothing behind and the next run re-prompts.
 * @see writeConsentFlag for the persisted counterpart.
 */
export function setSessionConsentOverride(enabled: boolean | null): void {
  sessionOverride = enabled;
}

/** Test seam: clear the config cache and any session override. */
export function _resetConsentCacheForTest(): void {
  cache.current = null;
  sessionOverride = null;
}
