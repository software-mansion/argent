/**
 * Artifact store — the registry's home for files a tool produces on the
 * tool-server host.
 *
 * A file-producing tool registers the file here and returns the resulting
 * {@link ArtifactHandle} instead of a raw host path; the client deep-walks tool
 * results for these markers and materializes the bytes on its own filesystem.
 * That is what keeps such tools working when the tool-server runs on another
 * machine, where a host path or a `127.0.0.1` URL means nothing.
 *
 * The store is a plain in-memory map; the route that streams `/artifacts/:id`
 * lives in the tool-server. It is owned by the {@link Registry} rather than
 * being a module singleton, so the tool `execute` path and the route resolve the
 * same instance.
 */

import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";

/** Discriminant key identifying an artifact handle inside a tool result. */
export const ARTIFACT_MARKER = "__argentArtifact" as const;

/** Wire contract: what a tool returns in place of a host path. */
export interface ArtifactHandle {
  [ARTIFACT_MARKER]: true;
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /**
   * Absolute path on this (tool-server) host. A co-located client reads the file
   * directly, but only after checking it against `size`/`mtimeMs`; a remote
   * client falls back to `/artifacts/:id`.
   */
  hostPath: string;
  /** mtime of `hostPath` (ms) at registration, for the client's integrity check. */
  mtimeMs?: number;
  /**
   * Set when `hostPath` is a directory (e.g. an Instruments `.trace` bundle).
   * `GET /artifacts/:id` then streams a gzipped tar that the client unpacks —
   * only for a remote client; a local one uses the directory in place.
   */
  archive?: "tar.gz";
  /**
   * Relative directory (e.g. `.argent/recordings`) the client should durably
   * persist this artifact into instead of the ephemeral temp cache. The client
   * resolves and validates the hint against its own roots, so for a remote
   * (`argent link`) tool-server the file lands on the *client* host, not the
   * server. Absent ⇒ disposable scratch.
   */
  saveDir?: string;
}

/** Internal entry the HTTP route reads to stream a registered artifact. */
export interface ArtifactEntry {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  isDirectory: boolean;
}

/** Public metadata returned by the artifact inventory endpoint. */
export interface ArtifactListItem {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  isDirectory: boolean;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

function inferMimeType(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export interface RegisterArtifactOptions {
  /** Override the basename presented to the client. Defaults to the host basename. */
  filename?: string;
  /** Override the inferred MIME type. */
  mimeType?: string;
  /**
   * Force directory (tar.gz) delivery even if the path can't be stat'd at
   * registration (e.g. a `.trace` bundle from a recovered session). Otherwise
   * directories are auto-detected via stat.
   */
  archive?: "tar.gz";
  /**
   * Durable destination for the artifact instead of the temp cache, surfaced to
   * the client on the handle. See {@link ArtifactHandle.saveDir}.
   */
  saveDir?: string;
}

/**
 * Process-scoped artifact store owned by a {@link Registry}: a tool registers an
 * entry during `execute`, and the `/artifacts/:id` route serves it later from
 * that same registry's store.
 */
export class ArtifactStore {
  private readonly entries = new Map<string, ArtifactEntry>();

  async register(hostPath: string, opts?: RegisterArtifactOptions): Promise<ArtifactHandle> {
    const filename = opts?.filename ?? basename(hostPath);
    const mimeType = opts?.mimeType ?? inferMimeType(hostPath);
    let size = 0;
    let mtimeMs: number | undefined;
    let isDirectory = opts?.archive === "tar.gz";
    try {
      const st = await stat(hostPath);
      size = st.size;
      mtimeMs = st.mtimeMs;
      if (st.isDirectory()) isDirectory = true;
    } catch {
      // size/mtime stay advisory: the file may be produced lazily. A co-located
      // client re-stats and falls back to download when they don't match.
    }
    const id = randomUUID();
    this.entries.set(id, { path: hostPath, filename, mimeType, size, isDirectory });
    const handle: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id,
      filename,
      mimeType,
      size,
      hostPath,
    };
    if (mtimeMs != null) handle.mtimeMs = mtimeMs;
    if (isDirectory) handle.archive = "tar.gz";
    if (opts?.saveDir) handle.saveDir = opts.saveDir;
    return handle;
  }

  get(id: string): ArtifactEntry | undefined {
    return this.entries.get(id);
  }

  list(): ArtifactListItem[] {
    return [...this.entries.entries()].map(([id, entry]) => ({
      id,
      filename: entry.filename,
      mimeType: entry.mimeType,
      size: entry.size,
      isDirectory: entry.isDirectory,
    }));
  }
}
