import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { argentHomeDir, identityFilePath } from "./paths.js";
import { uuidv5 } from "./uuidv5.js";

// Fixed namespace UUID for Argent telemetry machine ids. NEVER change this: it
// pins the deterministic mapping (host fingerprint -> distinct_id). Changing it
// would re-bucket every machine as a brand-new user.
const TELEMETRY_ID_NAMESPACE = "a8f1d3c2-6b04-4e7a-9d51-2c8e0f3a7b6d";

// The simulator-server `fingerprint` subcommand emits exactly 64 lowercase hex
// chars. Require that exact shape (after lower-casing) so a truncated/partial
// read, a bare hex token (git SHA, all-zeros), or an error banner is rejected
// and we fall back to a random id rather than hashing garbage into a "stable"
// id. uuidv5 is case-sensitive, so we lower-case before both matching and
// hashing — a future binary that emitted upper-case hex must map to the same id.
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

// In-memory cache of the resolved id. The anon id is stable once resolved, so
// the long-lived tool-server (which calls this on every tracked event) avoids
// re-reading the file — and re-spawning the fingerprint binary — each time.
// Keyed by the resolved path so a process whose home dir changes (e.g. tests
// scoping HOME) doesn't serve a stale id.
let cached: { path: string; id: string } | null = null;

// Memoize the fingerprint resolution (including a failed/absent one as null)
// independently of the id cache, so the binary is spawned AT MOST ONCE per
// process even if id-file persistence keeps failing (a broken ~/.argent would
// otherwise re-enter readOrCreateAnonId — and re-spawn — on every event).
let fingerprintResolved: { value: string | null } | null = null;

/**
 * Resolve the anonymous telemetry id.
 *
 * When `resolveFingerprint` yields a host fingerprint, the id is the
 * deterministic `uuidv5(fingerprint, NAMESPACE)` — so PostHog's native unique
 * users == unique machines. The persisted id file is migrated to that value
 * once, **locally only** (no PostHog alias/$identify event is ever emitted).
 *
 * Fallbacks (binary absent, command fails, no resolver injected): keep the
 * already-stored id, or mint a fresh random UUID. This function must never
 * throw on a fingerprint-resolution failure — telemetry stays best-effort.
 */
export function readOrCreateAnonId(resolveFingerprint?: () => string | null): string {
  const finalPath = identityFilePath();
  if (cached && cached.path === finalPath) return cached.id;

  const stored = tryReadId(finalPath);
  const target = deriveFingerprintId(resolveFingerprint);

  if (target) {
    // Deterministic per-machine id available. Migrate the file if it differs
    // (legacy random id, or none yet); idempotent once stored === target.
    if (stored !== target) {
      try {
        writeIdFileAtomic(finalPath, target);
      } catch {
        // Persisting the migration failed (e.g. ENOSPC / read-only home). The
        // id is deterministic, so we still return `target` in memory and stay
        // consistent across this process; a later run retries the rewrite.
      }
    }
    cached = { path: finalPath, id: target };
    return target;
  }

  // No usable fingerprint: keep whatever is already on disk.
  if (stored) {
    cached = { path: finalPath, id: stored };
    return stored;
  }

  // No fingerprint and no valid stored id: mint a random id. A corrupt / empty
  // regular file squatting the path (e.g. a truncated prior write from a legacy
  // or external writer) is cleared inside mintRandomId, behind its no-overwrite
  // link() — never by an up-front unlink. Crucially the corrupt occupant is
  // removed by CLAIMING it (atomic rename aside + inspect), not by unlinking the
  // path by name: so a valid id a concurrent self-healer publishes into the
  // check→clear gap is adopted, not destroyed — two concurrent heals converge on
  // one id instead of splitting a machine into two distinct_ids.
  return mintRandomId(finalPath);
}

/**
 * Run the injected resolver and map its fingerprint to the deterministic id.
 * Returns null when no resolver is injected, the resolver throws/returns
 * nothing, or the value doesn't look like a fingerprint.
 */
function deriveFingerprintId(resolveFingerprint?: () => string | null): string | null {
  const fingerprint = resolveFingerprintOnce(resolveFingerprint);
  return fingerprint ? uuidv5(fingerprint, TELEMETRY_ID_NAMESPACE) : null;
}

/**
 * Invoke the injected resolver at most once per process and cache the validated
 * fingerprint (or null). Returns the normalized (trimmed, lower-cased) 64-hex
 * fingerprint, or null when no resolver is injected, it throws/returns nothing,
 * or the value isn't a well-formed fingerprint.
 */
function resolveFingerprintOnce(resolveFingerprint?: () => string | null): string | null {
  // No resolver -> nothing to spawn or cache; callers without the binary always
  // pass undefined, so this can't poison a later resolver-bearing call.
  if (!resolveFingerprint) return null;
  if (fingerprintResolved) return fingerprintResolved.value;

  let value: string | null = null;
  let raw: string | null;
  try {
    raw = resolveFingerprint();
  } catch {
    raw = null;
  }
  if (raw) {
    const normalized = raw.trim().toLowerCase();
    if (FINGERPRINT_PATTERN.test(normalized)) value = normalized;
  }
  fingerprintResolved = { value };
  return value;
}

// True iff a regular file exists at filePath whose contents tryReadId rejects —
// a corrupt id file safe to overwrite. Symlinks / non-regular files return false
// so they are never followed or clobbered.
function isCorruptIdFile(filePath: string): boolean {
  let isRegularFile: boolean;
  try {
    isRegularFile = fs.lstatSync(filePath).isFile();
  } catch {
    return false; // absent (ENOENT) or unstatable
  }
  return isRegularFile && tryReadId(filePath) === null;
}

// Atomically replace the id file with `id` (mode 0600). Write to a temp file in
// the same dir, fsync, then rename() over the final path. rename() within a
// directory is atomic, so a concurrent reader sees either the old or new id,
// never a torn write — and two processes racing here both write the SAME
// deterministic value, so the result is identical regardless of who wins.
function writeIdFileAtomic(finalPath: string, id: string): void {
  fs.mkdirSync(argentHomeDir(), { recursive: true });
  const tmpPath = path.join(
    argentHomeDir(),
    `.telemetry-id.tmp.${process.pid}.${crypto.randomUUID()}`
  );
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    try {
      fs.writeSync(fd, id);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, finalPath);
  } finally {
    // rename() consumes tmpPath on success; on a pre-rename failure this cleans
    // up the orphan. ENOENT (already renamed) is ignored.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* nothing to clean up */
    }
  }
}

// Atomically create the id file with a fresh random UUID. link(2) gives a
// no-overwrite publish so concurrent first-run processes can't clobber each
// other; the loser reads the winner's value.
function mintRandomId(finalPath: string): string {
  fs.mkdirSync(argentHomeDir(), { recursive: true });

  // The id we publish. Starts random; if a corrupt-file self-heal below claims a
  // valid id that a racer published into the gap, we switch to adopting THAT
  // value and republish it on the next iteration, so concurrent heals converge.
  let value: string = crypto.randomUUID();

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
        fs.writeSync(fd, value);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // POSIX rename() would replace; link() gives us no-overwrite publish.
      fs.linkSync(tmpPath, finalPath);
      cached = { path: finalPath, id: value };
      return value;
    } catch (err) {
      // openSync's EEXIST is handled above; the only EEXIST reaching here is
      // from linkSync, i.e. something already occupies the final path.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const beatUs = tryReadId(finalPath);
        if (beatUs) {
          // A racer published a VALID id first — adopt it, never clobber. This
          // is the concurrency guarantee: whoever links first wins.
          cached = { path: finalPath, id: beatUs };
          return beatUs;
        }
        // The occupant is not a valid id. If a corrupt / empty *regular* file
        // squats the path (the self-heal case — a truncated prior write from a
        // legacy or external writer), clear it so the retry can publish. We must
        // NOT unlink finalPath by name: the tryReadId above and the removal are
        // not atomic, so a valid id a racer publishes into that gap would be
        // deleted by name, splitting the machine. claimCorruptOccupant instead
        // moves the occupant aside atomically (rename) and inspects it — if the
        // gap turned it into a valid id we adopt that value (republished on the
        // next iteration) rather than destroying it. A symlink / non-regular file
        // is left untouched (isCorruptIdFile is false for it) so we still fail
        // closed and throw.
        if (isCorruptIdFile(finalPath)) {
          const adopted = claimCorruptOccupant(finalPath);
          if (adopted) value = adopted;
        }
        // Occupant vanished / was cleared, or we adopted a racer's id to
        // republish: retry.
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

// Clear a non-id occupant squatting the identity path during a mint retry,
// without ever deleting a valid id by name. Unlinking finalPath directly is a
// TOCTOU: the caller's tryReadId (which rejected the occupant) and the removal
// are separate syscalls, so a valid id a racer publishes into that gap would be
// unlinked by name — splitting the machine into two distinct_ids. Instead we
// CLAIM the current occupant with an atomic rename aside: rename() relocates
// whatever inode is at finalPath right now without destroying it. We then
// inspect the relocated copy — if the gap had turned it into a valid id, its
// value is returned so the caller republishes and adopts it (converging both
// heals on one id); if it really was corrupt it is dropped and null is returned
// so the caller retries its own publish. A rename that fails (racer already
// cleared/moved it) also yields null → the caller re-evaluates.
function claimCorruptOccupant(finalPath: string): string | null {
  const claimed = path.join(
    argentHomeDir(),
    `.telemetry-id.corrupt.${process.pid}.${crypto.randomUUID()}`
  );
  try {
    fs.renameSync(finalPath, claimed);
  } catch {
    return null;
  }
  let grabbed: string | null;
  try {
    grabbed = tryReadId(claimed);
  } finally {
    // The relocated copy is our private temp now; drop it. An adopted id lives on
    // as a string value (republished by the caller), independent of this inode,
    // so removing the copy loses nothing.
    try {
      fs.unlinkSync(claimed);
    } catch {
      /* nothing to clean up */
    }
  }
  return grabbed;
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

/** Test seam: drop the in-memory id and fingerprint caches. */
export function _resetIdentityCacheForTest(): void {
  cached = null;
  fingerprintResolved = null;
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
