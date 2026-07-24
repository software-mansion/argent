/**
 * Artifact store — the registry's owned home for files a tool produces on the
 * tool-server host.
 *
 * Tools that produce a file (screenshots, profiler exports, …) register it here
 * and return the resulting {@link ArtifactHandle} in their result instead of a
 * raw host path. The handle is a wire contract: the MCP client deep-walks tool
 * results for these markers, downloads the bytes over the remote-aware HTTP
 * boundary (`GET /artifacts/:id`), and materializes them on the *client*
 * filesystem.
 *
 * This is what makes file-producing tools work when the tool-server runs on a
 * different machine than the agent: a `127.0.0.1` URL or a host path is
 * meaningless across the boundary, but an artifact id resolved through the tools
 * URL is not.
 *
 * The store is a plain in-memory map with no transport concerns — the HTTP
 * route that streams `/artifacts/:id` lives in the tool-server and reads from a
 * store instance via {@link ArtifactStore.get}. The store is owned by the
 * {@link Registry} (one per process, lifecycle tied to the registry) rather than
 * a module singleton, so both the tool `execute` path and the route resolve the
 * same instance through the registry.
 */

import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";

/** Discriminant key identifying an artifact handle inside a tool result. */
export const ARTIFACT_MARKER = "__argentArtifact" as const;

/**
 * Semantic artifact category, declared by the producing tool at registration.
 * MIME type tells a consumer how to read the bytes; kind tells it what the
 * artifact represents (a screenshot vs. the annotated diff of two screenshots,
 * a raw trace bundle vs. the report derived from it). Extending this union is
 * backward-compatible on the wire — clients treat unknown kinds as opaque.
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

/** Wire contract: what a tool returns in place of a host path. */
export interface ArtifactHandle {
  [ARTIFACT_MARKER]: true;
  id: string;
  /** Semantic category of the artifact — see {@link ArtifactKind}. */
  kind: ArtifactKind;
  filename: string;
  mimeType: string;
  size: number;
  /**
   * Absolute path of the file on this (tool-server) host. A co-located client
   * uses it to read the file directly instead of downloading it over
   * `/artifacts/:id`. The client verifies it against `size`/`mtimeMs` first, so
   * a remote client (where the path is meaningless or absent) simply falls back
   * to the download route.
   */
  hostPath: string;
  /** mtime of `hostPath` (ms) at registration, for the client's integrity check. */
  mtimeMs?: number;
  /**
   * Set when `hostPath` is a directory (e.g. an Instruments `.trace` bundle).
   * A single file can't represent a directory, so `GET /artifacts/:id` streams
   * it as a gzipped tar **only when a remote client actually requests it** —
   * never in local mode, where the client uses the directory in place via the
   * gate. The client unpacks the tar back into a directory after download.
   */
  archive?: "tar.gz";
  /**
   * A relative directory where the client should durably persist this artifact
   * instead of the ephemeral temp cache — e.g. `.argent/recordings` for a screen
   * recording. The client resolves it against its own project root (nearest
   * ancestor with `.git`/`package.json`/`.argent`, else its home dir) and
   * sanitizes it (relative, no `..`), so for a remote (`argent link`) tool-server
   * the file lands on the *client* host, not the server. Absent ⇒ the artifact
   * is disposable scratch.
   */
  saveDir?: string;
}

/** Internal entry the HTTP route reads to stream a registered artifact. */
export interface ArtifactEntry {
  path: string;
  kind: ArtifactKind;
  filename: string;
  mimeType: string;
  size: number;
  isDirectory: boolean;
}

/** Public metadata returned by the artifact inventory endpoint. */
export interface ArtifactListItem {
  id: string;
  kind: ArtifactKind;
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
  /** Absolute path of the file or directory on the tool-server host. */
  hostPath: string;
  /** Semantic category of the artifact, distinct from its MIME type. */
  kind: ArtifactKind;
  /** Override the basename presented to the client. Defaults to the host basename. */
  filename?: string;
  /** Override the inferred MIME type. */
  mimeType?: string;
  /**
   * Force directory (tar.gz) delivery even if the path can't be stat'd at
   * registration time (e.g. a `.trace` bundle referenced from a recovered
   * session). When omitted, directories are auto-detected via stat.
   */
  archive?: "tar.gz";
  /**
   * Relative directory to durably persist the artifact into (resolved on the
   * client against its project root, else home) instead of the temp cache —
   * surfaced to the client on the handle. See {@link ArtifactHandle.saveDir}.
   */
  saveDir?: string;
}

/**
 * Process-scoped artifact store, owned by a {@link Registry}. A tool registers
 * an entry during `execute` and the `/artifacts/:id` route — resolving the same
 * registry's store — serves it later.
 */
export class ArtifactStore {
  private readonly entries = new Map<string, ArtifactEntry>();

  async register(opts: RegisterArtifactOptions): Promise<ArtifactHandle> {
    const { hostPath, kind } = opts;
    const filename = opts.filename ?? basename(hostPath);
    const mimeType = opts.mimeType ?? inferMimeType(hostPath);
    let size = 0;
    let mtimeMs: number | undefined;
    let isDirectory = opts.archive === "tar.gz";
    try {
      const st = await stat(hostPath);
      size = st.size;
      mtimeMs = st.mtimeMs;
      if (st.isDirectory()) isDirectory = true;
    } catch {
      // File may be produced lazily or be a bundle directory; size/mtime are
      // advisory. A co-located client re-stats and falls back to download if
      // they don't match what's on disk at read time.
    }
    const id = randomUUID();
    this.entries.set(id, { path: hostPath, kind, filename, mimeType, size, isDirectory });
    const handle: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id,
      kind,
      filename,
      mimeType,
      size,
      hostPath,
    };
    if (mtimeMs != null) handle.mtimeMs = mtimeMs;
    if (isDirectory) handle.archive = "tar.gz";
    if (opts.saveDir) handle.saveDir = opts.saveDir;
    return handle;
  }

  get(id: string): ArtifactEntry | undefined {
    return this.entries.get(id);
  }

  list(): ArtifactListItem[] {
    return [...this.entries.entries()].map(([id, entry]) => ({
      id,
      kind: entry.kind,
      filename: entry.filename,
      mimeType: entry.mimeType,
      size: entry.size,
      isDirectory: entry.isDirectory,
    }));
  }
}
