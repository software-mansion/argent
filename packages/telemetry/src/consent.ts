import * as fs from "node:fs";
import { configFilePath } from "./paths.js";
import { updateConfig } from "./config-file.js";

// Consent is evaluated on every track() so a running tool server sees opt-outs.
// The config file is re-parsed only when its mtime or inode changes.
export interface ConsentSource {
  source:
    | "env_do_not_track"
    | "env_argent_telemetry"
    | "session_override"
    | "config_file"
    | "default";
  /** Detailed override identifier for `argent telemetry status` output. */
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

// Non-persisted, in-process consent decision for the current run. Set while a
// first-run consent choice is pending commit so the pick governs THIS session's
// events immediately, without writing to config.json. null means "no in-process
// override — fall through to the env / config / default precedence below".
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
    // File errors must not silently flip telemetry on.
    cache.current = { mtimeMs: null, fingerprint: null, enabledOverride: null };
    return null;
  }

  if (!stats.isFile()) {
    // Refuse to read symlinks / sockets / directories at that path.
    cache.current = { mtimeMs: null, fingerprint: null, enabledOverride: null };
    return null;
  }

  // Include size so a same-mtime edit (coarse filesystem mtime granularity, or
  // a same-millisecond in-place write that preserves the inode) still busts the
  // cache. Toggling telemetry.enabled true↔false always changes the byte length,
  // so a long-lived tool-server can't keep serving a stale "enabled" after the
  // user opts out within the same mtime tick.
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
    // Malformed config — treat as "no override" rather than crash.
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

/** Computes the effective consent state without mutating anything on disk. */
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

  // An in-process first-run choice that hasn't been committed to disk yet. It
  // loses to an explicit environment opt-out (handled above) but beats the
  // config file and the default, so a pending "Disabled" pick suppresses this
  // session's events even though the choice isn't persisted until the install
  // completes.
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

  // Default-on unless one of the explicit opt-out sources above applies.
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
 * Apply (or clear) an in-process consent decision for the current run without
 * touching config.json. `argent init` uses this so a first-run "Enable/Disable"
 * pick governs the session immediately, while the durable record is only written
 * once the install actually completes — an aborted init leaves nothing behind
 * (the override dies with the process) and the next run re-prompts. Pass null to
 * clear it. See `writeConsentFlag` for the persisted counterpart.
 */
export function setSessionConsentOverride(enabled: boolean | null): void {
  sessionOverride = enabled;
}

/** Test seam: blow away the in-memory mtime cache and any session override. */
export function _resetConsentCacheForTest(): void {
  cache.current = null;
  sessionOverride = null;
}
