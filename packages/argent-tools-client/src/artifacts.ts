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

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export interface MaterializedImage {
  localPath: string;
  data: Buffer;
  mimeType: string;
}

export interface MaterializeContext {
  toolsUrl: string;
  deviceId?: string;
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
    // `-C dir` recreates the bundle's own top-level directory inside `dir`. The
    // server tars `basename(hostPath)`, which equals `handle.filename`, so the
    // unpacked bundle lands at `dir/<filename>`.
    await execFileAsync("tar", ["-xzf", tarball, "-C", dir]);
    return join(dir, handle.filename);
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
      if (localPath) {
        if (value.mimeType.startsWith("image/")) {
          images.push({ localPath, data: await readFile(localPath), mimeType: value.mimeType });
        }
        return localPath;
      }
      try {
        const res = await fetchFn(`${ctx.toolsUrl}/artifacts/${value.id}`);
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
