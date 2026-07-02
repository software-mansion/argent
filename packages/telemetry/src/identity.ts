import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { argentHomeDir, identityFilePath } from "./paths.js";

// The simulator-server `fingerprint` subcommand emits exactly 64 lowercase hex
// chars — a one-way hash of stable hardware identifiers, so no raw hardware id
// is ever exposed. That validated hash is used verbatim as the telemetry
// distinct_id. Require the exact shape (after lower-casing) so a truncated read,
// a bare hex token (git SHA, all-zeros), or an error banner is rejected and we
// fall back to a random id rather than persisting garbage as a "stable" id. We
// lower-case before matching so a future binary emitting upper-case hex still
// maps to the same id — and it doubles as the self-describing marker for the
// fast path below (a fingerprint id is 64-hex; the random fallback is a dashed
// v4 UUID), letting us skip re-spawning the binary once one is on disk.
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

// In-memory cache of the resolved id. Keyed by the resolved path so a process
// whose home dir changes (e.g. tests scoping HOME) doesn't serve a stale id.
// Only a FINGERPRINT id is authoritative here — a cached fallback is provisional
// (a later async upgrade, or another process, may migrate the on-disk id to the
// fingerprint), so readOrCreateAnonId re-reads disk rather than short-circuiting
// on a cached fallback.
let cached: { path: string; id: string } | null = null;

// Memoize the SYNCHRONOUS fingerprint resolution (including a failed/absent one
// as null), so the blocking binary spawn on the truly-fresh path happens AT MOST
// ONCE per process even if id-file persistence keeps failing (a broken ~/.argent
// would otherwise re-enter readOrCreateAnonId — and re-spawn — on every event).
let fingerprintResolved: { value: string | null } | null = null;

// Coordination for the NON-BLOCKING async upgrade (scheduleFingerprintUpgrade):
// migrate a fallback id to the fingerprint in the background without ever
// stalling the event loop. Bounded — at most one probe in flight, spaced by a
// cooldown and capped — so a permanently-unfingerprintable binary can't spawn on
// every event; once the cap is hit the process still adopts a fingerprint any
// OTHER process migrates, via the cheap disk re-read in readOrCreateAnonId.
let upgradeInFlight = false;
let upgradeAttempts = 0;
let upgradeLastAttemptMs = 0;
const UPGRADE_COOLDOWN_MS = 60_000;
const UPGRADE_MAX_ATTEMPTS = 3;

/**
 * Resolve the anonymous telemetry id.
 *
 * When a host fingerprint is available, the id IS that fingerprint — the 64-hex
 * one-way hash emitted by `simulator-server fingerprint`, used verbatim so
 * PostHog's native unique users == unique machines, stable across reinstalls.
 *
 * Blocking is confined to ONE path: the truly-fresh machine (nothing valid on
 * disk yet), where the fingerprint is resolved SYNCHRONOUSLY so the very first
 * event this machine ever sends already carries the stable id instead of a
 * random fallback that later migrates (which would split the machine across two
 * distinct_ids). That spawn happens at most once per process (memoized).
 *
 * Every other case returns WITHOUT a blocking spawn:
 *  - a fingerprint id already on disk (or cached) → served directly (steady
 *    state; also how a stuck long-lived process adopts a fingerprint another
 *    process migrated — a cheap disk read);
 *  - a fallback id already on disk → returned as-is; the caller separately kicks
 *    off scheduleFingerprintUpgrade to migrate it in the background.
 *
 * Fallbacks (binary absent, command fails, no resolver injected): keep the
 * already-stored id, or mint a fresh random UUID. This function must never throw
 * on a fingerprint-resolution failure — telemetry stays best-effort.
 */
export function readOrCreateAnonId(resolveFingerprint?: () => string | null): string {
  const finalPath = identityFilePath();

  // Fast path A: a cached FINGERPRINT id is authoritative — serve without
  // touching disk. A cached FALLBACK is only provisional, so we do NOT
  // short-circuit on it: we fall through to re-read disk so a fingerprint that
  // an async upgrade or another process has since migrated is adopted.
  if (cached && cached.path === finalPath && FINGERPRINT_PATTERN.test(cached.id)) {
    return cached.id;
  }

  const stored = tryReadId(finalPath);

  // Fast path B: a fingerprint id is already persisted. Its canonical 64-hex
  // shape is self-describing (the random fallback is a dashed v4 UUID), so it is
  // the stable per-machine id and we return it WITHOUT spawning the binary. Only
  // the canonical LOWER-case form qualifies — our writers only ever persist
  // lower-case, so a mixed-case 64-hex value is an external write; it falls
  // through to the fallback path and the async upgrade rewrites it to canonical.
  if (stored && FINGERPRINT_PATTERN.test(stored)) {
    cached = { path: finalPath, id: stored };
    return stored;
  }

  // A valid (non-fingerprint) fallback id is already on disk. We are already
  // emitting under it, so there is no rush and no reason to pay a BLOCKING spawn
  // here: return it now. The caller's scheduleFingerprintUpgrade migrates it to
  // the fingerprint asynchronously, and the next call then hits fast path B.
  // This is what keeps a machine with a legacy id, or a binary that can't
  // fingerprint, from re-spawning and blocking on every process's first event.
  if (stored) {
    cached = { path: finalPath, id: stored };
    return stored;
  }

  // Truly fresh: nothing valid on disk (fresh install, or a corrupt/empty file).
  // This is the ONLY place the fingerprint is resolved SYNCHRONOUSLY — the
  // one-time cost, per machine, that lets the first-ever event carry the stable
  // id. At most once per process (memoized in resolveFingerprintOnce).
  const target = resolveFingerprintOnce(resolveFingerprint);
  if (target) {
    // Fingerprint available on a fresh machine: persist it. (stored is null here,
    // so this always writes; idempotent once persisted on later runs.)
    try {
      writeIdFileAtomic(finalPath, target);
    } catch {
      // Persisting failed (e.g. ENOSPC / read-only home). The fingerprint is
      // stable, so we still return `target` in memory and stay consistent across
      // this process; a later run retries the rewrite.
    }
    cached = { path: finalPath, id: target };
    return target;
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
 * Kick off a NON-BLOCKING upgrade of a fallback id to the host fingerprint.
 *
 * Called on tracked events (after readOrCreateAnonId) so a process currently
 * emitting under a fallback id — a legacy random id awaiting migration, a fresh
 * machine whose truly-fresh sync resolve failed transiently, or a long-lived
 * tool-server that started before the binary was warm — eventually converges on
 * the deterministic fingerprint WITHOUT ever blocking the event loop. On success
 * it migrates the on-disk id and updates the cache, so subsequent events use the
 * fingerprint; **local only**, no PostHog alias/$identify is emitted.
 *
 * Directly fixes the divergence where a stuck long-lived process kept emitting a
 * fallback while short-lived processes migrated the on-disk id to the
 * fingerprint (two distinct_ids for one machine). Never throws.
 *
 * No-op when: no async resolver is injected, a fingerprint id is already
 * established (cached or on disk), a probe is in flight, the cooldown has not
 * elapsed, or the attempt cap is reached.
 */
export function scheduleFingerprintUpgrade(
  resolveFingerprintAsync?: () => Promise<string | null>
): void {
  if (!resolveFingerprintAsync) return;
  if (upgradeInFlight) return;

  const finalPath = identityFilePath();

  // Already have the fingerprint (cached or persisted) → nothing to upgrade.
  if (cached && cached.path === finalPath && FINGERPRINT_PATTERN.test(cached.id)) return;
  const stored = tryReadId(finalPath);
  if (stored && FINGERPRINT_PATTERN.test(stored)) return;

  if (upgradeAttempts >= UPGRADE_MAX_ATTEMPTS) return;
  const now = Date.now();
  if (upgradeAttempts > 0 && now - upgradeLastAttemptMs < UPGRADE_COOLDOWN_MS) return;

  upgradeInFlight = true;
  upgradeAttempts += 1;
  upgradeLastAttemptMs = now;

  // Wrap in Promise.resolve().then so a synchronous throw from the resolver is
  // funnelled into .catch rather than escaping this function.
  void Promise.resolve()
    .then(() => resolveFingerprintAsync())
    .then((raw) => {
      const fp = normalizeFingerprint(raw);
      if (fp) adoptFingerprint(fp);
    })
    .catch(() => {
      /* best-effort: a failed probe just leaves the fallback in place */
    })
    .finally(() => {
      upgradeInFlight = false;
    });
}

/**
 * Establish the id OFF the hot path, for a long-lived entry point (the
 * tool-server) that must not pay a blocking resolve on its accept path.
 *
 * Resolves the fingerprint ASYNCHRONOUSLY (no event-loop stall) before the
 * server advertises readiness. On success the fingerprint is persisted; on
 * failure a fallback id is read or minted, so that by the time the first event
 * fires the on-disk id already exists and readOrCreateAnonId never enters its
 * synchronous truly-fresh resolve on the accept path. Returns the established id.
 * Best-effort: the fingerprint resolve never throws, and the only remaining
 * throw path is minting a fallback onto a wedged disk (ENOSPC/EROFS after
 * retries) — the sole caller (warmTelemetryIdentity) catches it.
 */
export async function warmIdentity(
  resolveFingerprintAsync?: () => Promise<string | null>
): Promise<string> {
  const finalPath = identityFilePath();

  if (cached && cached.path === finalPath && FINGERPRINT_PATTERN.test(cached.id)) {
    return cached.id;
  }
  const stored = tryReadId(finalPath);
  if (stored && FINGERPRINT_PATTERN.test(stored)) {
    cached = { path: finalPath, id: stored };
    return stored;
  }

  if (resolveFingerprintAsync) {
    let raw: string | null = null;
    try {
      raw = await resolveFingerprintAsync();
    } catch {
      /* leave raw as null — best-effort */
    }
    const fp = normalizeFingerprint(raw);
    if (fp) {
      adoptFingerprint(fp);
      return fp;
    }
  }

  // No fingerprint yet: ensure SOME id exists on disk (fallback), without a
  // blocking spawn — readOrCreateAnonId() with no sync resolver reads the stored
  // fallback or mints a random one. The next tracked event then returns it via
  // fast path (no truly-fresh resolve), and scheduleFingerprintUpgrade keeps
  // retrying the fingerprint in the background.
  return readOrCreateAnonId();
}

/** Validate and normalize a raw resolver output to a canonical 64-hex id. */
function normalizeFingerprint(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return FINGERPRINT_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Adopt a resolved fingerprint as the id: migrate the on-disk file to it (once,
 * if it differs) and update the in-memory cache so subsequent reads serve it.
 * The fingerprint is deterministic, so a rename-over race between processes is
 * safe (all write the same value). Best-effort persistence — an unwritable home
 * still yields a consistent in-memory id, and a later run retries the write.
 */
function adoptFingerprint(fp: string): void {
  const finalPath = identityFilePath();
  const stored = tryReadId(finalPath);
  if (stored !== fp) {
    try {
      writeIdFileAtomic(finalPath, fp);
    } catch {
      /* keep the deterministic id in memory; a later run retries the rewrite */
    }
  }
  cached = { path: finalPath, id: fp };
  // A fingerprint in `cached` is authoritative (fast path A), so readOrCreateAnonId
  // never re-reaches the sync resolver after this — no need to touch the
  // truly-fresh `fingerprintResolved` memo here.
}

/**
 * Invoke the injected SYNC resolver at most once per process and cache the
 * validated fingerprint (or null). Returns the normalized (trimmed, lower-cased)
 * 64-hex fingerprint, or null when no resolver is injected, it throws/returns
 * nothing, or the value isn't a well-formed fingerprint.
 */
function resolveFingerprintOnce(resolveFingerprint?: () => string | null): string | null {
  // No resolver -> nothing to spawn or cache; callers without the binary always
  // pass undefined, so this can't poison a later resolver-bearing call.
  if (!resolveFingerprint) return null;
  if (fingerprintResolved) return fingerprintResolved.value;

  let raw: string | null;
  try {
    raw = resolveFingerprint();
  } catch {
    raw = null;
  }
  const value = normalizeFingerprint(raw);
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

/** Test seam: drop the in-memory id, fingerprint, and async-upgrade state. */
export function _resetIdentityCacheForTest(): void {
  cached = null;
  fingerprintResolved = null;
  upgradeInFlight = false;
  upgradeAttempts = 0;
  upgradeLastAttemptMs = 0;
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
