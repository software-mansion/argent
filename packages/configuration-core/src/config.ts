import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { argentHomeDir, configFilePath } from "./paths.js";

// Shared read/write for ~/.argent/config.json. The config holds several
// independent keys (telemetry consent, first-run notices, Lens preferences,
// ...), so every writer must merge rather than overwrite, and publish
// atomically so an interrupted write can never truncate keys it does not own.

/** Parse the config document, returning an empty object when missing/malformed. */
export function readConfigObject(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    const json = JSON.parse(raw) as unknown;
    if (json && typeof json === "object") {
      return json as Record<string, unknown>;
    }
  } catch {
    /* missing or malformed — treat as a fresh document */
  }
  return {};
}

// A read → mutate → publish cycle completes in well under a second; a lock held
// longer than this is treated as orphaned by a crashed/`kill -9`'d writer and
// stolen, so a dead process can't wedge config writes forever.
const LOCK_STALE_MS = 10_000;
// Total time to wait for the lock before giving up and proceeding unlocked.
// Degrading to the old (lock-free) behavior is strictly no worse than before
// this lock existed and keeps a stuck peer from blocking the user's command.
const LOCK_MAX_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;

// Block the (single-threaded) script for `ms` without busy-spinning. Only ever
// reached under real cross-process contention, never in the common case.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface ConfigLock {
  fd: number;
  lockPath: string;
}

// Acquire an exclusive on-disk lock for config.json, or return null if it
// couldn't be taken within the budget (caller then proceeds best-effort). A
// non-null result must be released. Stale-lock recovery is best-effort: in the
// pathological case of two writers observing the same orphaned lock at once the
// steal can race, but that is vastly rarer than the lost-update it replaces.
function acquireConfigLock(): ConfigLock | null {
  const lockPath = configFilePath() + ".lock";
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } catch {
        /* recording the holder pid is advisory only */
      }
      return { fd, lockPath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
      // Held by another process. Steal it if it looks orphaned.
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock vanished between open and stat, or the stat/unlink itself
        // failed. Fall through to the deadline + backoff guard rather than
        // `continue`-ing: a persistent stat failure paired with a persistent
        // EEXIST on open would otherwise spin this into a tight, unbounded loop
        // (no deadline check, no sleep). The next iteration retries the open.
      }
      if (Date.now() >= deadline) return null;
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function releaseConfigLock(lock: ConfigLock): void {
  try {
    fs.closeSync(lock.fd);
  } catch {
    /* already closed */
  }
  try {
    fs.unlinkSync(lock.lockPath);
  } catch {
    /* already removed (e.g. stolen as stale by a peer) */
  }
}

/**
 * Apply `mutate` to the current config and persist the result atomically.
 *
 * Reads the existing document (preserving keys this caller does not touch),
 * lets `mutate` patch it in place, then writes to a temp file and renames so a
 * crash mid-write leaves the previous config intact.
 *
 * The whole read → mutate → publish cycle runs under a cross-process lock so a
 * concurrent writer touching a *different* key can't clobber ours: without it
 * two processes both read the old document, each patches only its own key, and
 * the last `rename` wins — silently dropping the other's change (e.g. a
 * telemetry opt-out lost behind a first-run-notice write).
 */
export function updateConfig(mutate: (config: Record<string, unknown>) => void): void {
  fs.mkdirSync(argentHomeDir(), { recursive: true });

  const lock = acquireConfigLock();
  try {
    const next = readConfigObject();
    mutate(next);

    const finalPath = configFilePath();
    const tmpPath = path.join(argentHomeDir(), `.config.tmp.${process.pid}.${crypto.randomUUID()}`);
    const fd = fs.openSync(tmpPath, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(next, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmpPath, finalPath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* nothing to clean up */
      }
      throw err;
    }
  } finally {
    if (lock) releaseConfigLock(lock);
  }
}

// ── Argent Lens preferences ──────────────────────────────────────────────
// Stored under the `lens` key of the shared config document, e.g.
// `{ "lens": { "agent": "claude" } }`. `argent lens` reads `agent` to skip the
// window's agent picker on subsequent runs, and writes it when the human ticks
// "Remember this choice".

/** Shape of the `lens` config section. Only the keys we read are typed. */
interface LensConfig {
  /** The coding-agent id last remembered for `argent lens` (e.g. "claude"). */
  agent?: string;
}

function readLensConfig(): LensConfig {
  const lens = readConfigObject().lens;
  return lens && typeof lens === "object" ? (lens as LensConfig) : {};
}

/** The remembered `argent lens` agent id, or null when none is stored. */
export function getRememberedAgent(): string | null {
  const agent = readLensConfig().agent;
  return typeof agent === "string" && agent.trim() ? agent : null;
}

/** Persist the chosen `argent lens` agent id so later runs skip the picker. */
export function setRememberedAgent(agentId: string): void {
  updateConfig((config) => {
    const lens =
      config.lens && typeof config.lens === "object"
        ? (config.lens as Record<string, unknown>)
        : {};
    lens.agent = agentId;
    config.lens = lens;
  });
}

/** Forget the remembered `argent lens` agent (so the picker shows again). */
export function clearRememberedAgent(): void {
  updateConfig((config) => {
    if (config.lens && typeof config.lens === "object") {
      delete (config.lens as Record<string, unknown>).agent;
    }
  });
}
