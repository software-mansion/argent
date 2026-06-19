import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { argentHomeDir, identityFilePath } from "./paths.js";

// In-memory cache of the resolved id. The anon id never changes once written,
// so the long-lived tool-server (which calls this on every tracked event)
// avoids re-reading the file each time. Keyed by the resolved path so a process
// whose home dir changes (e.g. tests scoping HOME) doesn't serve a stale id.
let cached: { path: string; id: string } | null = null;

// Read or atomically create the anonymous id. link(2) prevents concurrent
// first-run processes from overwriting each other.
export function readOrCreateAnonId(): string {
  const finalPath = identityFilePath();
  if (cached && cached.path === finalPath) return cached.id;

  const existing = tryReadId(finalPath);
  if (existing) {
    cached = { path: finalPath, id: existing };
    return existing;
  }

  fs.mkdirSync(argentHomeDir(), { recursive: true });

  const uuid = crypto.randomUUID();

  // The random tmp path should be unique; retry defensively anyway.
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmpPath = path.join(
      argentHomeDir(),
      `.telemetry-id.tmp.${process.pid}.${crypto.randomUUID()}`
    );
    let fd: number;
    try {
      fd = fs.openSync(tmpPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    // One try/finally around write + publish so the temp file is cleaned up on
    // any failure after openSync — a throwing writeSync/fsyncSync (e.g. ENOSPC,
    // EIO) must not leave a `.telemetry-id.tmp.*` orphan behind.
    try {
      try {
        fs.writeSync(fd, uuid);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // POSIX rename() would replace; link() gives us no-overwrite publish.
      fs.linkSync(tmpPath, finalPath);
      cached = { path: finalPath, id: uuid };
      return uuid;
    } catch (err) {
      // openSync's EEXIST is handled above; the only EEXIST reaching here is
      // from linkSync, i.e. another process published first.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const beatUs = tryReadId(finalPath);
        if (beatUs) {
          cached = { path: finalPath, id: beatUs };
          return beatUs;
        }
        // Final file vanished between link and read; retry.
        continue;
      }
      throw err;
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* nothing to clean up */
      }
    }
  }
  throw new Error("telemetry: failed to create anonymous identity after retries");
}

/** Read the anonymous id without creating one. Returns null if absent. */
export function peekAnonId(): string | null {
  return tryReadId(identityFilePath());
}

/** Delete the identity file. Used by uninstall cleanup. */
export function deleteAnonId(): void {
  cached = null;
  try {
    fs.unlinkSync(identityFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Test seam: drop the in-memory id cache. */
export function _resetIdentityCacheForTest(): void {
  cached = null;
}

function tryReadId(filePath: string): string | null {
  let raw: string;
  try {
    // lstat rejects symlinks at the identity path.
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile()) return null;
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  const value = raw.trim();
  // Accept a UUID-like value in case older versions wrote a different shape.
  if (/^[0-9a-fA-F-]{32,128}$/.test(value)) return value;
  return null;
}
