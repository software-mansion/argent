import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { argentHomeDir, identityFilePath } from "./paths.js";

// A fingerprint id is exactly 64 lowercase hex chars; the random fallback is a
// dashed v4 UUID. So this shape check both rejects malformed resolver output (a
// truncated read, a 40-hex git SHA, an error banner) before it can be persisted
// as a "stable" id, and tells the two id kinds apart once one is on disk.
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

// In-memory cache of the resolved id, keyed by resolved path so a changed home
// dir (e.g. tests scoping HOME) doesn't serve a stale id. Only a FINGERPRINT id
// is authoritative: a cached fallback may since have been migrated on disk by an
// async upgrade or another process, so readOrCreateAnonId re-reads disk for it.
let cached: { path: string; id: string } | null = null;

// Memoized SYNCHRONOUS fingerprint resolution (a failed/absent one included, as
// null), so the blocking spawn happens at most once per process even if id-file
// persistence keeps failing and every event re-enters readOrCreateAnonId.
let fingerprintResolved: { value: string | null } | null = null;

// Coordination for the non-blocking async upgrade (scheduleFingerprintUpgrade).
// Bounded — one probe in flight, a cooldown, an attempt cap — so a permanently
// unfingerprintable binary can't spawn on every event; past the cap the process
// still adopts a fingerprint another process migrates, via the disk re-read in
// readOrCreateAnonId.
let upgradeInFlight = false;
let upgradeAttempts = 0;
let upgradeLastAttemptMs = 0;
const UPGRADE_COOLDOWN_MS = 60_000;
const UPGRADE_MAX_ATTEMPTS = 3;

/**
 * Resolve the telemetry id: the 64-hex host fingerprint when one is available,
 * so the distinct id counts machines rather than installs.
 *
 * Blocking is confined to ONE path: the truly-fresh machine (nothing valid on
 * disk), resolved SYNCHRONOUSLY so the first event already carries the stable id
 * instead of a random fallback that later migrates — which would split the
 * machine across two distinct_ids. That spawn happens at most once per process.
 *
 * Every other case returns without a spawn: a fingerprint id on disk (or cached)
 * is served directly — also how a long-lived process adopts a fingerprint another
 * process migrated — and a fallback id on disk is returned as-is, with the caller
 * separately kicking off scheduleFingerprintUpgrade to migrate it.
 *
 * Never throws on a fingerprint-resolution failure; telemetry stays best-effort.
 */
export function readOrCreateAnonId(resolveFingerprint?: () => string | null): string {
  const finalPath = identityFilePath();

  // Fast path A: only a cached FINGERPRINT is authoritative. A cached fallback
  // falls through to a disk re-read, to pick up a fingerprint an async upgrade or
  // another process has since migrated.
  if (cached && cached.path === finalPath && FINGERPRINT_PATTERN.test(cached.id)) {
    return cached.id;
  }

  const stored = tryReadId(finalPath);

  // Fast path B: a persisted fingerprint is the stable per-machine id — serve it
  // WITHOUT spawning. Only the canonical LOWER-case form qualifies: our writers
  // only ever persist lower-case, so mixed-case 64-hex is an external write and
  // falls through to the fallback path, where the async upgrade rewrites it.
  if (stored && FINGERPRINT_PATTERN.test(stored)) {
    cached = { path: finalPath, id: stored };
    return stored;
  }

  // A fallback id is already on disk and we are already emitting under it, so no
  // BLOCKING spawn here: return it, and the caller's scheduleFingerprintUpgrade
  // migrates it in the background so the next call hits fast path B. This is what
  // keeps a machine with a legacy id, or a binary that can't fingerprint, from
  // re-spawning on every process's first event.
  if (stored) {
    cached = { path: finalPath, id: stored };
    return stored;
  }

  // Truly fresh: nothing valid on disk (fresh install, or a corrupt/empty file).
  // The ONLY synchronous resolve — the one-time, per-machine cost that lets the
  // first-ever event carry the stable id. At most once per process.
  const target = resolveFingerprintOnce(resolveFingerprint);
  if (target) {
    // `stored` is null here, so this always writes.
    try {
      writeIdFileAtomic(finalPath, target);
    } catch {
      // Unwritable home (ENOSPC, read-only): the fingerprint is stable, so keep
      // it in memory and let a later run retry the write.
    }
    cached = { path: finalPath, id: target };
    return target;
  }

  // No fingerprint and no valid stored id: mint a random one. A corrupt/empty
  // regular file squatting the path is cleared inside mintRandomId by CLAIMING it
  // (atomic rename aside, then inspect) rather than by unlinking the path by name,
  // so a valid id a concurrent self-healer publishes into the check→clear gap is
  // adopted rather than destroyed — two heals converge on one id.
  return mintRandomId(finalPath);
}

/**
 * Kick off a NON-BLOCKING upgrade of a fallback id to the host fingerprint, so a
 * process emitting under one — a legacy random id, a fresh machine whose sync
 * resolve failed transiently, a long-lived tool-server that started before the
 * binary was warm — converges on the fingerprint without stalling the event loop.
 * On success it migrates the on-disk id and the cache; **local only**, no remote
 * identity/alias event is emitted.
 *
 * Fixes the divergence where a stuck long-lived process kept emitting a fallback
 * while short-lived processes migrated the on-disk id (two distinct_ids for one
 * machine). Never throws.
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
  if (servedFingerprintId(finalPath)) return;

  if (upgradeAttempts >= UPGRADE_MAX_ATTEMPTS) return;
  const now = Date.now();
  if (upgradeAttempts > 0 && now - upgradeLastAttemptMs < UPGRADE_COOLDOWN_MS) return;

  upgradeInFlight = true;
  upgradeAttempts += 1;
  upgradeLastAttemptMs = now;

  // Promise.resolve().then funnels a synchronous throw from the resolver into
  // .catch instead of letting it escape this function.
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
 * Resolves the fingerprint ASYNCHRONOUSLY before the server advertises readiness;
 * on failure a fallback id is read or minted. Either way an on-disk id exists
 * before the first event, so readOrCreateAnonId never enters its synchronous
 * truly-fresh resolve on the accept path. Returns the established id.
 *
 * Best-effort: the resolve never throws, and the only remaining throw path is
 * minting onto a wedged disk (ENOSPC/EROFS after retries), which the caller
 * (warmTelemetryIdentity) catches.
 */
export async function warmIdentity(
  resolveFingerprintAsync?: () => Promise<string | null>
): Promise<string> {
  const finalPath = identityFilePath();
  const served = servedFingerprintId(finalPath);
  if (served) return served;

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

  // No fingerprint yet: ensure SOME id exists on disk without a blocking spawn —
  // readOrCreateAnonId with no sync resolver reads the stored fallback or mints
  // one. The next event then hits a fast path, and scheduleFingerprintUpgrade
  // keeps retrying the fingerprint in the background.
  return readOrCreateAnonId();
}

/**
 * Establish the id BEFORE the first event, for a SHORT-LIVED entry point (the
 * installer CLI) that can afford to block briefly but must NOT await the async
 * resolver.
 *
 * Why sync, not `warmIdentity`: resolveHostFingerprintAsync unrefs its child,
 * stdout pipe and watchdog so a background probe never holds a CLI open — awaited
 * as the only pending work, that promise stays unsettled and the process EXITS.
 * This variant resolves SYNCHRONOUSLY (execFileSync, SIGKILL-bounded) instead.
 *
 * Unlike readOrCreateAnonId — which serves an on-disk fallback WITHOUT resolving,
 * the hot-path contract that keeps the tool-server's accept path unblocked — this
 * DELIBERATELY forces the resolve and migrates a legacy/fresh fallback up front,
 * so the first tracked event carries the stable id rather than the one the
 * background upgrade would only reach afterwards. On failure it falls back to
 * readOrCreateAnonId and the caller's per-event scheduleFingerprintUpgrade
 * retries. Best-effort; the only throw path is minting onto a wedged disk, which
 * the wrapper catches.
 */
export function warmIdentitySync(resolveFingerprint?: () => string | null): string {
  const finalPath = identityFilePath();
  const served = servedFingerprintId(finalPath);
  if (served) return served;

  // Force the (memoized, at-most-once) sync resolve even over a legacy fallback,
  // then migrate on-disk + cache so the next readOrCreateAnonId serves it cached.
  const fp = resolveFingerprintOnce(resolveFingerprint);
  if (fp) {
    adoptFingerprint(fp);
    return fp;
  }

  return readOrCreateAnonId();
}

/**
 * An already-established FINGERPRINT id — from the cache, or from disk (which
 * refreshes the cache) — or null if none is established yet.
 *
 * A 64-hex fingerprint is the terminal, per-machine id: any path that finds one
 * is done and returns it WITHOUT resolving the binary. Shared prologue of the two
 * warm entry points and scheduleFingerprintUpgrade. readOrCreateAnonId inlines
 * the same two checks instead, because it also needs the non-fingerprint `stored`
 * value afterwards and routing through here would re-read the file.
 */
function servedFingerprintId(finalPath: string): string | null {
  if (cached && cached.path === finalPath && FINGERPRINT_PATTERN.test(cached.id)) {
    return cached.id;
  }
  const stored = tryReadId(finalPath);
  if (stored && FINGERPRINT_PATTERN.test(stored)) {
    cached = { path: finalPath, id: stored };
    return stored;
  }
  return null;
}

/** Trim and lower-case a raw resolver output; null unless it is then 64-hex. */
function normalizeFingerprint(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return FINGERPRINT_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Adopt a resolved fingerprint as the id: migrate the on-disk file to it (if it
 * differs) and update the cache. The fingerprint is deterministic, so a
 * rename-over race between processes is safe. Best-effort persistence — an
 * unwritable home still yields a consistent in-memory id, and a later run retries.
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
  // A fingerprint in `cached` is authoritative (fast path A), so the sync resolver
  // is never reached again — no need to touch the `fingerprintResolved` memo.
}

/**
 * Invoke the injected SYNC resolver at most once per process, caching the
 * normalized fingerprint or null (no resolver, it threw, or a malformed value).
 */
function resolveFingerprintOnce(resolveFingerprint?: () => string | null): string | null {
  // Return without memoizing, so a later resolver-bearing call can still resolve.
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

// True iff a regular file at filePath holds contents tryReadId rejects — a
// corrupt id file safe to overwrite. Symlinks / non-regular files return false so
// they are never followed or clobbered.
function isCorruptIdFile(filePath: string): boolean {
  let isRegularFile: boolean;
  try {
    isRegularFile = fs.lstatSync(filePath).isFile();
  } catch {
    return false; // absent (ENOENT) or unstatable
  }
  return isRegularFile && tryReadId(filePath) === null;
}

// Atomically replace the id file with `id` (mode 0600): write a temp file in the
// same dir, fsync, then rename() over the final path, so a concurrent reader sees
// either the old or the new id, never a torn write. Two processes racing here
// write the SAME deterministic value.
function writeIdFileAtomic(finalPath: string, id: string): void {
  fs.mkdirSync(argentHomeDir(), { recursive: true });

  // Fail closed on a NON-REGULAR occupant (symlink, dir, fifo, ...). rename() does
  // not follow a symlink, so without this guard the fingerprint writers would
  // swap a symlink at the identity path for a regular file while the mint path
  // leaves it untouched; both id writers must treat the occupant alike. Callers
  // treat a write failure as best-effort, so the symlink is preserved.
  let occupant: fs.Stats | undefined;
  try {
    occupant = fs.lstatSync(finalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (occupant && !occupant.isFile()) {
    throw new Error("telemetry: refusing to replace a non-regular file at the identity path");
  }

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
    // rename() consumed tmpPath on success; otherwise clean up the orphan.
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

  // Starts random; if the self-heal below claims a valid id a racer published into
  // the gap, we switch to that value and republish it, so concurrent heals
  // converge.
  let value: string = crypto.randomUUID();

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
    // One try/finally around write + publish so a throwing writeSync/fsyncSync
    // (ENOSPC, EIO) can't leave a `.telemetry-id.tmp.*` orphan behind.
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
          // A racer published a VALID id first — adopt it, never clobber.
          cached = { path: finalPath, id: beatUs };
          return beatUs;
        }
        // The occupant is not a valid id. If a corrupt/empty *regular* file squats
        // the path, clear it so the retry can publish — but never by unlinking
        // finalPath by name: the tryReadId above and the removal are separate
        // syscalls, so a valid id a racer publishes into that gap would be deleted,
        // splitting the machine. claimCorruptOccupant moves the occupant aside
        // atomically and inspects it, adopting a value that turned out valid. A
        // symlink / non-regular file is left untouched, so we still fail closed.
        if (isCorruptIdFile(finalPath)) {
          const adopted = claimCorruptOccupant(finalPath);
          if (adopted) value = adopted;
        }
        // Occupant vanished / was cleared, or we adopted a racer's id: retry.
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
  throw new Error("telemetry: failed to create identity after retries");
}

// Clear a non-id occupant squatting the identity path during a mint retry without
// ever deleting a valid id by name. Unlinking finalPath directly is a TOCTOU: the
// caller's tryReadId and the removal are separate syscalls, so a valid id a racer
// publishes into that gap would be unlinked, splitting the machine into two
// distinct_ids. Instead rename the current inode aside — atomic, non-destructive
// — and inspect it: a valid id is returned for the caller to republish and adopt,
// a truly corrupt one is dropped and null returned so the caller retries its own
// publish. A rename that fails (a racer already cleared it) also yields null.
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
    // as a string value, independent of this inode.
    try {
      fs.unlinkSync(claimed);
    } catch {
      /* nothing to clean up */
    }
  }
  return grabbed;
}

/** Read the id without creating one. Returns null if absent. */
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
  if (/^[0-9a-fA-F-]{32,128}$/.test(value)) return value;
  return null;
}
