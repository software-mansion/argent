import * as fs from "node:fs";
import { argentHomeDir, configFilePath } from "./paths.js";

// Consent is evaluated on every track() so a running tool server sees opt-outs.
// The config file is re-parsed only when its mtime or inode changes.
export interface ConsentSource {
  source: "env_do_not_track" | "env_argent_telemetry" | "config_file" | "default";
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

function parseTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Computes the effective consent state without mutating anything on disk. */
export function getConsentState(env: NodeJS.ProcessEnv = process.env): ConsentState {
  if (parseTruthy(env.DO_NOT_TRACK)) {
    return { enabled: false, source: { source: "env_do_not_track", detail: "DO_NOT_TRACK=1" } };
  }

  const argentEnv = env.ARGENT_TELEMETRY;
  if (parseFalsy(argentEnv)) {
    return {
      enabled: false,
      source: { source: "env_argent_telemetry", detail: `ARGENT_TELEMETRY=${argentEnv}` },
    };
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
  fs.mkdirSync(argentHomeDir(), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    const json = JSON.parse(raw) as unknown;
    if (json && typeof json === "object") {
      existing = json as Record<string, unknown>;
    }
  } catch {
    /* missing or malformed — write a fresh document */
  }

  const telemetryBlock =
    typeof existing.telemetry === "object" && existing.telemetry
      ? (existing.telemetry as Record<string, unknown>)
      : {};

  const next: Record<string, unknown> = {
    ...existing,
    telemetry: {
      ...telemetryBlock,
      enabled,
    },
  };

  fs.writeFileSync(configFilePath(), JSON.stringify(next, null, 2) + "\n");
  cache.current = null;
}

/** Test seam: blow away the in-memory mtime cache. */
export function _resetConsentCacheForTest(): void {
  cache.current = null;
}
