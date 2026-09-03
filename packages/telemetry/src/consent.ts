import * as fs from "node:fs";
import { updateConfig, type ConfigPathOptions, type FlagScope } from "@argent/configuration-core";
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

// One cache entry per config document (global `~/.argent/config.json` and the
// project `<root>/.argent/config.json`), keyed by absolute path.
const cache = new Map<string, CachedConfig>();

// In-process consent decision, never written to config.json: set while a
// first-run pick is pending commit so it governs THIS session's events.
let sessionOverride: boolean | null = null;

function readConfigOverrideAt(filePath: string): boolean | null {
  const miss: CachedConfig = { mtimeMs: null, fingerprint: null, enabledOverride: null };
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    // ENOENT (the common case for a project without an opt-out) or any other
    // stat failure — no override.
    cache.set(filePath, miss);
    return null;
  }

  if (!stats.isFile()) {
    // Refuse to read symlinks / sockets / directories at that path.
    cache.set(filePath, miss);
    return null;
  }

  // Size is in the fingerprint so an edit landing in the same mtime tick still
  // busts the cache: toggling enabled true↔false always changes the byte length.
  const fingerprint = `${stats.dev}:${stats.ino}:${stats.size}`;
  const mtimeMs = stats.mtimeMs;

  const cached = cache.get(filePath);
  if (cached && cached.fingerprint === fingerprint && cached.mtimeMs === mtimeMs) {
    return cached.enabledOverride;
  }

  let parsedEnabled: boolean | null = null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
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

  cache.set(filePath, { mtimeMs, fingerprint, enabledOverride: parsedEnabled });
  return parsedEnabled;
}

/** Which config document(s) set `telemetry.enabled`, when any did. */
interface PersistedConsent {
  enabled: boolean;
  /** Human-readable origin for `argent telemetry status`. */
  detail: string;
}

// The project scope resolves from `cwd` (nearest `.argent` / `.git` /
// `package.json` ancestor). Restrictive merge: `false` in EITHER document wins,
// so a committed project opt-out holds on every teammate's machine and a
// project file can never re-enable what the user turned off globally.
function readPersistedConsent(cwd: string): PersistedConsent | null {
  const globalPath = configFilePath("global");
  const projectPath = configFilePath("project", { cwd });
  const global = readConfigOverrideAt(globalPath);
  // A project rooted at `~` reads the same file twice; count it once.
  const project = projectPath === globalPath ? null : readConfigOverrideAt(projectPath);

  if (project === false && global === false) {
    return { enabled: false, detail: "config.json (project and global)" };
  }
  if (project === false) return { enabled: false, detail: "config.json (project)" };
  if (global === false) return { enabled: false, detail: "config.json (global)" };
  if (project === true || global === true) {
    return {
      enabled: true,
      detail: project === true ? "config.json (project)" : "config.json (global)",
    };
  }
  return null;
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
export function getConsentState(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): ConsentState {
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

  const persisted = readPersistedConsent(cwd);
  if (persisted !== null) {
    return {
      enabled: persisted.enabled,
      source: { source: "config_file", detail: persisted.detail },
    };
  }

  return { enabled: true, source: { source: "default" } };
}

export function isEnabled(env: NodeJS.ProcessEnv = process.env, cwd?: string): boolean {
  return getConsentState(env, cwd).enabled;
}

/**
 * Persist the telemetry flag without discarding other config keys. `scope`
 * picks the document: `global` (`~/.argent/config.json`, the default) or
 * `project` (`<project-root>/.argent/config.json`, resolved from `cwd`, meant
 * to be committed so the opt-out travels with the repository).
 */
export function writeConsentFlag(
  enabled: boolean,
  scope: FlagScope = "global",
  options: ConfigPathOptions = {}
): void {
  updateConfig(
    (config) => {
      const telemetryBlock =
        typeof config.telemetry === "object" && config.telemetry
          ? (config.telemetry as Record<string, unknown>)
          : {};
      config.telemetry = { ...telemetryBlock, enabled };
    },
    scope,
    options
  );
  cache.clear();
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
  cache.clear();
  sessionOverride = null;
}
