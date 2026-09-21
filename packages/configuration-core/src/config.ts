import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { configDir, configFilePath, type ConfigPathOptions } from "./paths.js";
import type { FlagScope } from "./flags.js";

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

export function configDocumentProblem(
  scope: FlagScope = "global",
  options: ConfigPathOptions = {}
): string | undefined {
  const file = configFilePath(scope, options);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `${file} could not be read (${err instanceof Error ? err.message : String(err)})`;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (err) {
    return `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return `${file} does not hold a JSON object`;
  }
  return undefined;
}

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

export function getAtPath(obj: Record<string, unknown>, dottedKey: string): unknown {
  const parts = splitKey(dottedKey);
  let cur: unknown = obj;
  for (const part of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

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

export function deleteAtPath(obj: Record<string, unknown>, dottedKey: string): boolean {
  const parts = splitKey(dottedKey);
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
const LOCK_MAX_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;

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
