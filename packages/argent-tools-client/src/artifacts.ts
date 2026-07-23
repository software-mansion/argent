/**
 * Artifact materializer — the client side of the remote file boundary.
 *
 * Shared by both consumers of the tool-server (the MCP server and the CLI).
 * Tool results from the (possibly remote) tool-server carry {@link ArtifactHandle}
 * markers in place of host paths. This module deep-walks a result, resolves each
 * handle to a real **local** path — reading it in place when the file is already
 * on this host, or downloading it over the remote-aware tools URL
 * (`GET /artifacts/:id`) into a cache under the OS temp dir — and rewrites the
 * marker to that path so all downstream rendering is location-agnostic.
 *
 * The root lives in `tmpdir()` so materialized artifacts are disposable scratch
 * the OS reclaims — matching how the sim-server (its own TempDir) and the
 * profiler (`tmpdir()/argent-profiler-cwd`) already treat produced files, and
 * leaving no persistent footprint under $HOME. Point ARGENT_ARTIFACTS_DIR at a
 * durable location to opt into cross-session persistence.
 *
 * Cache layout (override the root with ARGENT_ARTIFACTS_DIR):
 *
 *   <root>/<project>/<session>/<device>/<filename>
 *
 * - project  — basename(cwd) + short hash of the full path. Readable yet
 *              collision-safe across multiple checkouts of the same repo.
 * - session  — minted once per client process, so re-runs don't pile into one
 *              bucket and old sessions are trivially GC-able.
 * - device   — udid / serial when the artifact is device-scoped; omitted
 *              otherwise.
 */

import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from "node:path";
import { createHash } from "node:crypto";

import { safeExtractTarGz } from "@argent/archive";
import { argentHomeDir, findProjectRoot } from "@argent/configuration-core";

/** Must match the tool-server's wire contract (`tool-server/src/artifacts.ts`). */
export const ARTIFACT_MARKER = "__argentArtifact" as const;

export interface ArtifactHandle {
  [ARTIFACT_MARKER]: true;
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /**
   * Absolute path of the file on the tool-server host. When the tool-server is
   * co-located with this client, the file is already on disk here — the gate
   * reads it directly instead of downloading it over `/artifacts/:id`, avoiding
   * a redundant second copy. Verified against {@link size}/{@link mtimeMs}
   * before it is trusted; any mismatch (or a remote host) falls back to the
   * download path. Absent on older tool-servers that don't emit it.
   */
  hostPath?: string;
  /** mtime of {@link hostPath} (ms) at registration, for the integrity check. */
  mtimeMs?: number;
  /**
   * Present when the artifact is a directory bundle (e.g. an Instruments
   * `.trace`). Locally the gate uses the directory in place; on a remote miss
   * the download is a gzipped tar that the client unpacks back into a directory.
   */
  archive?: "tar.gz";
  /**
   * A relative directory the tool asked the artifact to be durably persisted
   * into — e.g. `.argent/recordings` for a screen recording — instead of the
   * ephemeral temp cache. The client resolves it against its own project root
   * (the nearest ancestor with `.git`/`package.json`/`.argent`), falling back to
   * its home when not in a project, and hardens it (relative, no `..`) before
   * use — so for a remote `argent link` server the file lands *here*, on the
   * client, in the project it belongs to. Absent ⇒ disposable temp-cache scratch.
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
 * Base directory the `saveDir` hint is resolved against: the client's project
 * root when it is inside one, else the user's home. This is what makes a
 * recording land in the *project's* `.argent/recordings/` (shared with the rest
 * of argent's per-project config) while still working — under the global
 * `~/.argent/recordings/` — when the client is run from somewhere that isn't a
 * project (no `.git`/`package.json`/`.argent` in any ancestor). Anchored at the
 * project root rather than raw cwd so a recording taken from a subdirectory
 * still lands in the one project-level `.argent`.
 */
function durableBaseDir(): string {
  const projectRoot = findProjectRoot(process.cwd());
  // argentHomeDir() is `<home>/.argent`; its parent is the home dir, and the
  // `saveDir` hint (`.argent/recordings`) re-adds the `.argent` segment — so the
  // global fallback resolves to `~/.argent/recordings`, matching the project
  // case's `<root>/.argent/recordings`.
  return projectRoot ?? dirname(argentHomeDir());
}

/**
 * The durable save destinations the client will honor — a client-side allowlist.
 * `saveDir` arrives on the wire from a possibly-remote or compromised `argent
 * link` tool-server, so the set of directories an artifact may be persisted into
 * is decided *here*, on the client, not by whatever value the server sends. Every
 * entry is a project-relative directory under argent's own `.argent/` tree; the
 * `filename` (sanitized to a single segment) then lands inside it. Add an entry
 * when a new tool needs a durable home. Stored normalized so the wire value is
 * compared in the same form regardless of separator style.
 */
const ALLOWED_SAVE_DIRS: ReadonlySet<string> = new Set([normalize(".argent/recordings")]);

/**
 * Hard ceiling on a single durable download, independent of the `size` the
 * (possibly hostile) tool-server announces. A durable artifact is persisted
 * where it survives temp-cache GC, so a remote/compromised `argent link` server
 * must not be able to drive unbounded client memory use or a persistent disk
 * fill under `.argent/recordings/` by streaming a body larger than it claimed.
 * Well above any real recording (600 s cap at device-native h264), so it only
 * ever trips a pathological stream. 2 GiB also stays within Node's `Buffer`
 * limit, since the download is buffered before it is written.
 */
const MAX_DURABLE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Read a fetch response body into a Buffer, refusing to buffer more than `cap`
 * bytes. Rejects early when the declared `Content-Length` already exceeds the
 * cap, and otherwise aborts the stream the moment the accumulated bytes pass it
 * — so a server that under-declares its `size` then streams an unbounded body
 * can't exhaust memory. Falls back to a still-capped `arrayBuffer()` read when
 * the response exposes no readable stream (e.g. an injected test fetch). Returns
 * null when the cap is exceeded.
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
 * Persist a durable artifact without ever overwriting an existing file. The
 * artifact's own filename is tried first; if it is already taken, it lands
 * alongside as `name (2).ext`, `name (3).ext`, … The write is *exclusive*
 * (`wx` / `COPYFILE_EXCL`), so a collision is detected atomically — two
 * concurrent materializations can't clobber each other, and a tool-server can't
 * silently replace a recording already in `.argent/recordings/` by reusing its
 * name. Returns the final path, or null if no free name is found within the
 * bound (a pathological directory, not a real collision).
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
 * Resolve an artifact's durable save destination from its `saveDir` hint, or
 * `null` when it has none (⇒ the disposable temp cache is used instead). The
 * hint (e.g. `.argent/recordings`) is resolved against {@link durableBaseDir} —
 * the client's project root, or its home when not in a project — so a file
 * produced by a remote (`argent link`) tool-server is persisted on the *client*
 * host, in the project it belongs to.
 *
 * The hint is hardened before use: a directory bundle (`archive`) is excluded
 * (durable persistence is for single files only), and — crucially — the value
 * must be on {@link ALLOWED_SAVE_DIRS}, the client's own allowlist. A relative,
 * non-`..` path is *not* enough: the base is the project root, so an unlisted
 * destination like `.git` (⇒ overwriting `.git/config` for code execution), `.`
 * (a source file or `package.json`), or `.argent` (argent's own config) all sit
 * *inside* the base and would otherwise be writable by a hostile tool-server.
 * The absolute/`..` structural checks stay as defense in depth. A rejected hint
 * falls back to `null`, so an untrusted `saveDir` degrades to scratch rather than
 * writing somewhere dangerous.
 */
export function durableSaveTarget(
  handle: ArtifactHandle
): { dir: string; path: string; base: string; rel: string } | null {
  if (!handle.saveDir || handle.archive) return null;
  const rel = normalize(handle.saveDir);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.split(sep).includes("..")
  ) {
    return null;
  }
  // The destination must be one the client sanctions — not merely a
  // non-escaping relative path, which still resolves *inside* the project root
  // (where `.git`, sources, and argent's own config live).
  if (!ALLOWED_SAVE_DIRS.has(rel)) return null;
  const base = durableBaseDir();
  const dir = join(base, rel);
  // `base` and `rel` are returned so the caller can re-check, after `mkdir`,
  // that the *resolved* directory still lands at `<base>/<rel>` — the allowlist
  // is a lexical check and can't see a symlink standing in for `dir` (or one of
  // its segments) that redirects the write elsewhere. See {@link
  // confineToRealBase}.
  return { dir, path: join(dir, sanitizeSegment(handle.filename)), base, rel };
}

/**
 * Guard against a symlinked durable directory. The allowlist and `..` checks in
 * {@link durableSaveTarget} are purely lexical, and the exclusive leaf write
 * only protects the final file — so if `.argent/recordings` (or an ancestor
 * segment) is a **symlink** pre-planted in the victim's checkout, a durable
 * write would follow it out of the intended directory (e.g. into `.git`, where
 * a fresh file under `hooks/` is code execution). After the directory exists,
 * verify its real path is exactly `<realpath(base)>/<rel>`: the base itself may
 * legitimately be reached through a symlink (e.g. macOS `/var`→`/private/var`),
 * but the `rel` portion must not traverse one. Returns false ⇒ the durable
 * write is refused and the artifact degrades to the disposable cache.
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
   * Bearer token for the tool-server. Required when the server is remote and
   * authenticated (`argent link`); the `/artifacts/:id` route sits behind the
   * same auth gate as `/tools`, so a token-less download would 401 and the
   * artifact would read as missing. Empty/unset ⇒ unauthenticated server.
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
 * Resolve a handle's `hostPath` to a directly-usable local file, or `null` if
 * it can't be trusted. The file must exist, be a regular file, and match the
 * handle's recorded `size` (and `mtimeMs` when present). This is the gate's
 * "is the file already here?" check: it succeeds when the tool-server is
 * co-located (same machine, or a shared filesystem — where a match means it's
 * literally the same file), and fails for a genuinely remote host, falling
 * through to the download path. The integrity check guards against a stale or
 * unrelated file sitting at the same path.
 */
async function resolveLocalFile(handle: ArtifactHandle): Promise<string | null> {
  if (!handle.hostPath) return null;
  try {
    const st = await stat(handle.hostPath);
    if (handle.archive) {
      // Directory bundle: existence as a directory is the integrity check
      // (size/mtime are meaningless for a dir). A hit means we use the bundle
      // in place — the remote tar.gz round-trip is skipped entirely.
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
 * Download a directory artifact (a gzipped tar) and unpack it back into a
 * directory under `dir`, returning the unpacked path. Uses the system `tar`
 * (universally present on macOS/Linux and Windows 10+); returns null if `tar`
 * is unavailable or extraction fails, so a missing bundle degrades to a
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
    // Slip-hardened: a compromised tool-server shouldn't be able to write
    // outside the artifact cache via a `../` member.
    return await safeExtractTarGz(tarball, dir, handle.filename);
  } catch {
    return null;
  } finally {
    await rm(tarball, { force: true }).catch(() => {});
  }
}

/**
 * Walk `result`, resolving every artifact handle to a local path, and return
 * the rewritten result plus any image artifacts. Each handle is resolved by a
 * gate: if its `hostPath` is already readable locally (co-located tool-server),
 * it is used in place with no copy; otherwise the bytes are downloaded over
 * `/artifacts/:id` into a temp cache. Either way the handle is replaced by a
 * real local path, so all downstream rendering is location-agnostic. A handle
 * that resolves to neither is rewritten to `null` so the caller sees a
 * missing-file signal rather than a dangling reference. Results with no handles
 * pass through untouched (no fetch, no temp dir created).
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

      // Durable destination (e.g. `.argent/recordings`): persist under the
      // client's own cwd instead of the disposable temp cache. Copy when the
      // file is already local (co-located server), download otherwise — so an
      // `argent link` recording ends up on the *client* host, not the server.
      const saveTarget = durableSaveTarget(value);
      if (saveTarget) {
        const filename = basename(saveTarget.path);
        try {
          await mkdir(saveTarget.dir, { recursive: true });
          // Refuse to write through a symlinked durable directory — the lexical
          // allowlist and the exclusive leaf write don't cover a symlink at
          // `.argent/recordings` (or an ancestor) that redirects the whole write
          // out of the intended tree (e.g. into `.git`).
          if (!(await confineToRealBase(saveTarget.dir, saveTarget.base, saveTarget.rel))) {
            return null;
          }
          if (localPath) {
            // Already on this host — copy without buffering the whole file
            // (recordings can be large); only re-read if it's an inline image.
            // Exclusive copy so a colliding name never clobbers an existing
            // durable recording — it lands alongside as `name (2).ext`.
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
          // Remote download. A durable file survives cache GC, so it must have a
          // known, verified size: refuse a `size:0` handle (its length can't be
          // checked) and cap the streamed bytes, so a linked tool-server can't
          // persist an unbounded or under-declared body under `.argent/`.
          if (value.size <= 0) return null;
          const res = await fetchFn(`${ctx.toolsUrl}/artifacts/${value.id}`, {
            headers: authHeaders,
          });
          if (!res.ok) return null;
          const data = await readCapped(res, Math.min(value.size, MAX_DURABLE_BYTES));
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
        // Directory bundle: the download is a gzipped tar — unpack it back into
        // a directory rather than writing the archive as a single file.
        if (value.archive === "tar.gz") {
          return await downloadAndExtractArchive(value, data, dir);
        }
        // Integrity: don't persist a cleanly-truncated download as if it were
        // whole. Mirrors the gate's size check on the local path; skipped when
        // size is unknown (0, e.g. a lazily-registered file).
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
