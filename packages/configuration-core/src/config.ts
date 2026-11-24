import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { configDir, configFilePath, type ConfigPathOptions } from "./paths.js";
import type { FlagScope } from "./flags.js";

// Shared read/write for the `.argent/config.json` documents, at both the
// `global` (`~/.argent`) and `project` (`<project-root>/.argent`) scopes. One
// document holds independent keys owned by different writers (telemetry
// consent, first-run notices, Lens preferences), so every write merges and
// publishes atomically rather than truncating keys it does not own.

/** Parse a scope's config document; `{}` when missing or malformed. */
export function readConfigObject(
  scope: FlagScope = "global",
  options: ConfigPathOptions = {}
): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(configFilePath(scope, options), "utf8");
    const json = JSON.parse(raw) as unknown;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      return json as Record<string, unknown>;
    }
  } catch {
    /* missing or malformed — treat as a fresh document */
  }
  return {};
}

// Config keys are dotted paths into the nested document. The helpers below
// refuse segments through which a crafted key could reach `Object.prototype`.

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function splitKey(dottedKey: string): string[] {
  const parts = dottedKey.split(".");
  if (parts.length === 0 || parts.some((p) => p === "")) {
    throw new Error(`Invalid config key "${dottedKey}": empty path segment`);
  }
  for (const p of parts) {
    if (FORBIDDEN_SEGMENTS.has(p)) {
      throw new Error(`Invalid config key "${dottedKey}": forbidden segment "${p}"`);
    }
  }
  return parts;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Read the value at a dotted key, or `undefined` when any segment is missing. */
export function getAtPath(obj: Record<string, unknown>, dottedKey: string): unknown {
  const parts = splitKey(dottedKey);
  let cur: unknown = obj;
  for (const part of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Set the value at a dotted key, creating intermediate objects as needed. */
export function setAtPath(obj: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const parts = splitKey(dottedKey);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    if (!isPlainObject(next)) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/**
 * Delete the leaf at a dotted key. Returns true when something was removed.
 *
 * Containers this delete emptied are removed with it, so unsetting the last key
 * under a group leaves no `{ "ios": {} }` behind. The unwind stops at the first
 * ancestor that still holds something, and the root always survives (an emptied
 * config is `{}`, never a deleted file).
 */
export function deleteAtPath(obj: Record<string, unknown>, dottedKey: string): boolean {
  const parts = splitKey(dottedKey);
  // Every container on the way to the leaf, so emptied ones can be unwound
  // afterwards. chain[i] holds parts[i].
  const chain: Record<string, unknown>[] = [obj];
  for (let i = 0; i < parts.length - 1; i++) {
    const next = chain[i]![parts[i]!];
    if (!isPlainObject(next)) return false;
    chain.push(next);
  }
  const parent = chain[parts.length - 1]!;
  const leaf = parts[parts.length - 1]!;
  if (!Object.hasOwn(parent, leaf)) return false;
  delete parent[leaf];
  for (let i = chain.length - 1; i >= 1; i--) {
    if (Object.keys(chain[i]!).length > 0) break;
    delete chain[i - 1]![parts[i - 1]!];
  }
  return true;
}

// A read → mutate → publish cycle takes well under a second, so a lock older
// than this is treated as orphaned by a dead writer and stolen — a crashed
// process can't wedge config writes forever.
const LOCK_STALE_MS = 10_000;
// Wait budget before giving up and proceeding unlocked: degrading to the old
// lock-free behavior beats letting a stuck peer block the user's command.
const LOCK_MAX_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;

// Block the (single-threaded) script for `ms` without busy-spinning.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface ConfigLock {
  fd: number;
  lockPath: string;
}

// Exclusive on-disk lock for config.json; null when it couldn't be taken within
// the budget, and the caller then proceeds best-effort. A non-null result must
// be released. Two writers seeing the same orphaned lock can both steal it, but
// that is vastly rarer than the lost update the lock replaces.
function acquireConfigLock(finalPath: string): ConfigLock | null {
  const lockPath = finalPath + ".lock";
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
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Fall through to the deadline + backoff guard rather than
        // `continue`-ing: a persistent stat failure paired with a persistent
        // EEXIST on open would otherwise spin this into a tight, unbounded loop.
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
    /* best-effort */
  }
  try {
    fs.unlinkSync(lock.lockPath);
  } catch {
    /* already removed, e.g. stolen as stale by a peer */
  }
}

/**
 * Apply `mutate` to the current config and persist the result atomically.
 *
 * `mutate` patches the existing document in place, which is then written to a
 * temp file and renamed, so a crash mid-write leaves the previous config intact.
 *
 * The whole read → mutate → publish cycle runs under a cross-process lock:
 * without it two processes both read the old document, each patches only its
 * own key, and the last `rename` wins — silently dropping the other's change
 * (e.g. a telemetry opt-out lost behind a first-run-notice write).
 */
export function updateConfig(
  mutate: (config: Record<string, unknown>) => void,
  scope: FlagScope = "global",
  options: ConfigPathOptions = {}
): void {
  const dir = configDir(scope, options);
  fs.mkdirSync(dir, { recursive: true });

  const finalPath = configFilePath(scope, options);
  const lock = acquireConfigLock(finalPath);
  try {
    const next = readConfigObject(scope, options);
    mutate(next);

    const tmpPath = path.join(dir, `.config.tmp.${process.pid}.${crypto.randomUUID()}`);
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
