/**
 * Artifact materializer — the client side of the remote file boundary, shared
 * by both consumers of the tool-server (the MCP server and the CLI).
 *
 * Tool results carry {@link ArtifactHandle} markers in place of host paths;
 * each is rewritten to a real **local** path — read in place when the file is
 * already on this host, else downloaded over `GET /artifacts/:id` — so all
 * downstream rendering is location-agnostic.
 *
 * Cache layout, rooted in `tmpdir()` so it is scratch the OS reclaims (point
 * ARGENT_ARTIFACTS_DIR elsewhere for cross-session persistence):
 *
 *   <root>/<project>/<session>/<device>/<filename>
 *
 * - project  — basename(cwd) + hash of the full path, so multiple checkouts of
 *              one repo stay separate.
 * - session  — minted once per client process, keeping re-runs apart and old
 *              sessions trivially GC-able.
 * - device   — udid / serial when the artifact is device-scoped.
 */

import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

import { safeExtractTarGz } from "@argent/archive";
import { argentHomeDir, findProjectRoot, getConfigValueByKey } from "@argent/configuration-core";

/** Must match the tool-server's wire contract (`tool-server/src/artifacts.ts`). */
export const ARTIFACT_MARKER = "__argentArtifact" as const;

/**
 * Semantic artifact categories the tool-server emits today. Must match the
 * server-side union (`registry/src/artifacts.ts`). Kept separate on purpose:
 * this client may talk to a tool-server that is older (no `kind` at all) or
 * newer (kinds this build has never heard of), so consumers read `kind`
 * through {@link ArtifactHandle.kind}'s widened, optional type and treat
 * anything unrecognized as opaque.
 */
export type ArtifactKind =
  | "screenshot"
  | "screenshot-diff"
  | "screenshot-diff-context"
  | "screen-recording"
  | "native-profile-trace"
  | "native-profile-cpu"
  | "native-profile-hangs"
  | "native-profile-leaks"
  | "native-profile-report"
  | "react-profile-cpu"
  | "react-profile-commits"
  | "react-profile-report";

export interface ArtifactHandle {
  [ARTIFACT_MARKER]: true;
  id: string;
  /**
   * Semantic category of the artifact, distinct from MIME type. Absent when
   * the tool-server predates artifact kinds; may hold a value outside
   * {@link ArtifactKind} when the server is newer than this client — the
   * `string & {}` arm keeps that honest while preserving autocomplete.
   */
  kind?: ArtifactKind | (string & {});
  filename: string;
  mimeType: string;
  size: number;
  /**
   * Absolute path of the file on the tool-server host. A co-located client
   * reads it in place instead of downloading over `/artifacts/:id`, but only
   * after verifying {@link size}/{@link mtimeMs}; a mismatch (or a remote host)
   * falls back to the download path.
   */
  hostPath?: string;
  /** mtime of {@link hostPath} (ms) at registration, for the integrity check. */
  mtimeMs?: number;
  /**
   * Present when the artifact is a directory bundle (e.g. an Instruments
   * `.trace`). Used in place locally; on a remote miss the download is a
   * gzipped tar the client unpacks back into a directory.
   */
  archive?: "tar.gz";
  /**
   * Relative directory the tool asks the artifact to be durably persisted into
   * — e.g. `.argent/recordings` — instead of the temp cache. Resolved and
   * hardened client-side (see {@link durableSaveTarget}), so with a remote
   * `argent link` server the file lands *here*. Absent ⇒ temp-cache scratch.
   */
  saveDir?: string;
}

export function isArtifactHandle(value: unknown): value is ArtifactHandle {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>)[ARTIFACT_MARKER] === true &&
    typeof (value as ArtifactHandle).id === "string" &&
    typeof (value as ArtifactHandle).filename === "string"
  );
}

let SESSION_ID: string | null = null;
function sessionId(): string {
  if (!SESSION_ID) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
      .slice(0, 15);
    SESSION_ID = `${stamp}-${process.pid}`;
  }
  return SESSION_ID;
}

function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, "_");
}

function projectSlug(): string {
  const cwd = process.cwd();
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 6);
  const name = sanitizeSegment(basename(cwd)) || "root";
  return `${name}-${hash}`;
}

export function artifactsRoot(): string {
  return process.env.ARGENT_ARTIFACTS_DIR ?? join(tmpdir(), "argent-artifacts");
}

export function artifactDir(deviceId?: string): string {
  const parts = [artifactsRoot(), projectSlug(), sessionId()];
  if (deviceId) parts.push(sanitizeSegment(deviceId));
  return join(...parts);
}

/**
 * Base the `saveDir` hint resolves against: the client's project root (nearest
 * ancestor with `.argent`/`.git`/`package.json`), else the user's home. Anchored
 * at the project root rather than raw cwd so a recording taken from a
 * subdirectory still lands in the one project-level `.argent`.
 */
function durableBaseDir(): string {
  const projectRoot = findProjectRoot(process.cwd());
  // argentHomeDir() is `<home>/.argent`, so its parent is the home dir and the
  // hint re-adds the `.argent` segment: the global fallback lands on
  // `~/.argent/recordings`, mirroring `<root>/.argent/recordings`.
  return projectRoot ?? dirname(argentHomeDir());
}

/**
 * Durable destinations the client will honor. `saveDir` arrives on the wire from
 * a possibly-compromised `argent link` tool-server, so which directories may be
 * written is decided here, not by the server. Add an entry when a new tool needs
 * a durable home. Stored normalized to match the wire value's separator style.
 */
const ALLOWED_SAVE_DIRS: ReadonlySet<string> = new Set([normalize(".argent/recordings")]);

/**
 * The wire hint a finished screen recording arrives with. Fixed, so old and new
 * clients/servers interoperate; `recordings.directory` redirects where it lands
 * (see {@link configuredRecordingsDir}).
 */
const RECORDINGS_SAVE_DIR = normalize(".argent/recordings");

/**
 * Effective `recordings.directory` (project scope over global), or null when
 * unset, blank, or unreadable. Read on *this* host, since the mp4 is persisted
 * client-side. `~`/`~/…` expands to home, a relative path is anchored at
 * {@link durableBaseDir}, an absolute one is used as-is. Unlike the wire
 * `saveDir` hint this comes from the client's own config, so it is trusted to
 * name any directory the user can write to.
 */
function configuredRecordingsDir(): string | null {
  let value: unknown;
  try {
    value = getConfigValueByKey("recordings.directory");
  } catch {
    // Unknown key can't happen (it's on the schema); a broken config file or
    // an unparsable value degrades to the default location.
    return null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const home = dirname(argentHomeDir());
  const expanded =
    trimmed === "~"
      ? home
      : trimmed.startsWith("~/") || trimmed.startsWith(`~${sep}`)
        ? join(home, trimmed.slice(2))
        : trimmed;
  return resolve(durableBaseDir(), expanded);
}

/**
 * Hard ceiling on a durable download, independent of the `size` a possibly
 * hostile tool-server announces: a durable file survives temp-cache GC, so an
 * over-declared body must not be able to fill the disk or client memory. Well
 * above any real recording (600 s cap at device-native h264).
 */
const MAX_DURABLE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Read a response body into a Buffer, or null once `cap` bytes are exceeded —
 * checked against `Content-Length` up front and again per chunk, so a server
 * that under-declares its `size` then streams on can't exhaust memory. Falls
 * back to a still-capped `arrayBuffer()` when the response exposes no readable
 * stream (e.g. an injected test fetch).
 */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const headers = (res as { headers?: { get?: (k: string) => string | null } }).headers;
  const declared = Number(headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;

  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > cap ? null : buf;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Persist a durable artifact without ever overwriting an existing file: the
 * artifact's filename first, else `name (2).ext`, `name (3).ext`, … `write` must
 * be exclusive (`wx` / `COPYFILE_EXCL`) so collisions are detected atomically —
 * concurrent materializations can't clobber each other and a tool-server can't
 * replace an existing recording by reusing its name. Null ⇒ no free name within
 * the bound (a pathological directory, not a real collision).
 */
async function writeDurableUnique(
  dir: string,
  filename: string,
  write: (path: string) => Promise<void>
): Promise<string | null> {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 1; i <= 1000; i++) {
    const candidate = i === 1 ? filename : `${stem} (${i})${ext}`;
    const path = join(dir, candidate);
    try {
      await write(path);
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      throw err;
    }
  }
  return null;
}

/**
 * Resolve an artifact's durable destination from its `saveDir` hint, or `null`
 * (⇒ the temp cache) when it has none or the hint is rejected. Resolved against
 * {@link durableBaseDir} so a remote (`argent link`) artifact is persisted on
 * the *client* host.
 *
 * Directory bundles are excluded (durable persistence is single-file only) and
 * the hint must be on {@link ALLOWED_SAVE_DIRS}. A relative, non-`..` path is
 * not enough: the base is the project root, so `.git` (⇒ `.git/config` for code
 * execution), `.` (sources, `package.json`) and `.argent` all sit inside it. The
 * absolute/`..` checks stay as defense in depth.
 */
export function durableSaveTarget(
  handle: ArtifactHandle
): { dir: string; path: string; base: string; rel: string } | null {
  // `saveDir` is unvalidated wire JSON. A truthy non-string would make
  // `normalize()` throw `ERR_INVALID_ARG_TYPE`, and this runs *outside* the
  // caller's try/catch — rejecting the whole `materializeArtifacts` and losing
  // every sibling artifact instead of degrading this one to the temp cache.
  if (typeof handle.saveDir !== "string" || !handle.saveDir || handle.archive) return null;
  const rel = normalize(handle.saveDir);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.split(sep).includes("..")
  ) {
    return null;
  }
  // Must be a destination the client sanctions — a merely non-escaping relative
  // path still resolves inside the project root.
  if (!ALLOWED_SAVE_DIRS.has(rel)) return null;
  // The wire value has only *selected* a sanctioned destination kind; where it
  // lands comes from the client's own config. With `recordings.directory` set,
  // `base` is that directory and `rel` is empty, so the post-mkdir real-path
  // check degenerates to "it resolves to itself" — a user-chosen path may
  // legitimately be, or traverse, a symlink, exactly as the default base may.
  if (rel === RECORDINGS_SAVE_DIR) {
    const configured = configuredRecordingsDir();
    if (configured) {
      return {
        dir: configured,
        path: join(configured, sanitizeSegment(handle.filename)),
        base: configured,
        rel: "",
      };
    }
  }
  const base = durableBaseDir();
  const dir = join(base, rel);
  // `base`/`rel` let the caller re-check after `mkdir` that the *resolved*
  // directory is still `<base>/<rel>`: the allowlist is lexical and can't see a
  // symlink standing in for a segment of `dir`. See {@link confineToRealBase}.
  return { dir, path: join(dir, sanitizeSegment(handle.filename)), base, rel };
}

/**
 * Guard against a symlinked durable directory: a pre-planted symlink at
 * `.argent/recordings` (or an ancestor segment) would carry the write out of the
 * intended tree — e.g. into `.git/hooks`, which is code execution — and neither
 * the lexical checks in {@link durableSaveTarget} nor the exclusive leaf write
 * catch that. `base` itself may legitimately be reached through a symlink (macOS
 * `/var`→`/private/var`); only `rel` must not traverse one. False ⇒ refuse the
 * durable write and fall back to the disposable cache.
 */
async function confineToRealBase(dir: string, base: string, rel: string): Promise<boolean> {
  try {
    const realDir = await realpath(dir);
    const realBase = await realpath(base);
    return realDir === join(realBase, rel);
  } catch {
    return false;
  }
}

export interface MaterializedImage {
  localPath: string;
  data: Buffer;
  mimeType: string;
}

export interface MaterializeContext {
  toolsUrl: string;
  deviceId?: string;
  /**
   * Bearer token for the tool-server. `/artifacts/:id` sits behind the same auth
   * gate as `/tools`, so against an authenticated (`argent link`) server a
   * token-less download 401s and the artifact reads as missing. Empty/unset ⇒
   * unauthenticated server.
   */
  authToken?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface MaterializeResult {
  /** The result with every artifact handle replaced by its local path string. */
  result: unknown;
  /** Image artifacts encountered, for inline rendering by the caller. */
  images: MaterializedImage[];
}

/**
 * The gate's "is the file already here?" check: resolve a handle's `hostPath`
 * when it exists, is a regular file, and matches the recorded `size` (and
 * `mtimeMs` when present), else null. Succeeds for a co-located tool-server
 * (same machine or shared filesystem) and fails for a genuinely remote one,
 * falling through to the download path; the size/mtime match is what rules out
 * a stale or unrelated file sitting at that path.
 */
async function resolveLocalFile(handle: ArtifactHandle): Promise<string | null> {
  if (!handle.hostPath) return null;
  try {
    const st = await stat(handle.hostPath);
    if (handle.archive) {
      // Directory bundle: size/mtime are meaningless for a dir, so existence as
      // one is the whole check; a hit skips the tar.gz round-trip.
      return st.isDirectory() ? handle.hostPath : null;
    }
    if (!st.isFile()) return null;
    if (st.size !== handle.size) return null;
    if (handle.mtimeMs != null && Math.round(st.mtimeMs) !== Math.round(handle.mtimeMs)) {
      return null;
    }
    return handle.hostPath;
  } catch {
    return null;
  }
}

/**
 * Unpack a downloaded gzipped tar back into a directory under `dir`, returning
 * the unpacked path. Null when extraction fails, so a bad bundle degrades to a
 * missing-file signal rather than throwing.
 */
async function downloadAndExtractArchive(
  handle: ArtifactHandle,
  data: Buffer,
  dir: string
): Promise<string | null> {
  const tarball = join(dir, `${sanitizeSegment(handle.filename)}.tar.gz`);
  try {
    await writeFile(tarball, data);
    // Slip-hardened: a `../` member must not write outside the cache.
    return await safeExtractTarGz(tarball, dir, handle.filename);
  } catch {
    return null;
  } finally {
    await rm(tarball, { force: true }).catch(() => {});
  }
}

/**
 * Walk `result`, replacing every artifact handle with a local path, and return
 * the rewritten result plus any image artifacts. A handle whose `hostPath` is
 * readable here is used in place with no copy; otherwise the bytes are
 * downloaded over `/artifacts/:id` into the temp cache. Neither ⇒ `null`, so the
 * caller sees a missing-file signal rather than a dangling reference. Results
 * with no handles pass through untouched (no fetch, no temp dir created).
 */
export async function materializeArtifacts(
  result: unknown,
  ctx: MaterializeContext
): Promise<MaterializeResult> {
  const images: MaterializedImage[] = [];
  const fetchFn = ctx.fetchImpl ?? fetch;
  const authHeaders: Record<string, string> = ctx.authToken
    ? { Authorization: `Bearer ${ctx.authToken}` }
    : {};
  const dir = artifactDir(ctx.deviceId);
  let dirReady = false;

  async function ensureDir(): Promise<void> {
    if (!dirReady) {
      await mkdir(dir, { recursive: true });
      dirReady = true;
    }
  }

  async function walk(value: unknown): Promise<unknown> {
    if (isArtifactHandle(value)) {
      // Gate: prefer the file already on this host; only download on a miss.
      const localPath = await resolveLocalFile(value);

      // Durable destination (e.g. `.argent/recordings`) instead of the
      // disposable temp cache: copy when the file is already local, download
      // otherwise — so an `argent link` recording ends up on the *client* host.
      const saveTarget = durableSaveTarget(value);
      if (saveTarget) {
        const filename = basename(saveTarget.path);
        try {
          await mkdir(saveTarget.dir, { recursive: true });
          // Refuse to write through a symlinked durable directory.
          if (!(await confineToRealBase(saveTarget.dir, saveTarget.base, saveTarget.rel))) {
            return null;
          }
          if (localPath) {
            // Already on this host — copy without buffering the whole file
            // (recordings can be large); only re-read if it's an inline image.
            const finalPath = await writeDurableUnique(saveTarget.dir, filename, (p) =>
              copyFile(localPath, p, fsConstants.COPYFILE_EXCL)
            );
            if (!finalPath) return null;
            if (value.mimeType.startsWith("image/")) {
              images.push({
                localPath: finalPath,
                data: await readFile(finalPath),
                mimeType: value.mimeType,
              });
            }
            return finalPath;
          }
          // A durable file survives cache GC, so it must have a known, verified
          // size. `size` is unvalidated wire JSON, and an absent/NaN one would
          // make the `readCapped` cap `NaN` and never trip, letting an unbounded
          // body buffer into memory — the exact DoS the cap exists to prevent.
          if (!Number.isInteger(value.size) || value.size <= 0 || value.size > MAX_DURABLE_BYTES) {
            return null;
          }
          const res = await fetchFn(`${ctx.toolsUrl}/artifacts/${value.id}`, {
            headers: authHeaders,
          });
          if (!res.ok) return null;
          const data = await readCapped(res, value.size);
          if (!data || data.length !== value.size) return null;
          const finalPath = await writeDurableUnique(saveTarget.dir, filename, (p) =>
            writeFile(p, data, { flag: "wx" })
          );
          if (!finalPath) return null;
          if (value.mimeType.startsWith("image/")) {
            images.push({ localPath: finalPath, data, mimeType: value.mimeType });
          }
          return finalPath;
        } catch {
          return null;
        }
      }

      if (localPath) {
        if (value.mimeType.startsWith("image/")) {
          images.push({ localPath, data: await readFile(localPath), mimeType: value.mimeType });
        }
        return localPath;
      }
      try {
        const res = await fetchFn(`${ctx.toolsUrl}/artifacts/${value.id}`, {
          headers: authHeaders,
        });
        if (!res.ok) return null;
        const data = Buffer.from(await res.arrayBuffer());
        await ensureDir();
        // Directory bundle: unpack the tar rather than writing it as a file.
        if (value.archive === "tar.gz") {
          return await downloadAndExtractArchive(value, data, dir);
        }
        // Don't persist a cleanly-truncated download as if it were whole.
        // Skipped when size is unknown (0, e.g. a lazily-produced file).
        if (value.size > 0 && data.length !== value.size) return null;
        const downloadedPath = join(dir, sanitizeSegment(value.filename));
        await writeFile(downloadedPath, data);
        if (value.mimeType.startsWith("image/")) {
          images.push({ localPath: downloadedPath, data, mimeType: value.mimeType });
        }
        return downloadedPath;
      } catch {
        return null;
      }
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map(walk));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = await walk(v);
      }
      return out;
    }
    return value;
  }

  const rewritten = await walk(result);
  return { result: rewritten, images };
}

/** Pull a device id from tool args (`udid` or `device_id`) for cache scoping. */
export function getDeviceIdFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rec = args as Record<string, unknown>;
  if (typeof rec.udid === "string") return rec.udid;
  if (typeof rec.device_id === "string") return rec.device_id;
  return undefined;
}
