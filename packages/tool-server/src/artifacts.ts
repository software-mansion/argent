/**
 * Artifact registry — the tool-server side of the remote file boundary.
 *
 * Tools that produce a file on the tool-server host (screenshots, profiler
 * exports, …) register it here and return the resulting {@link ArtifactHandle}
 * in their result instead of a raw host path. The handle is a wire contract:
 * the MCP client (`argent-mcp`) deep-walks tool results for these markers,
 * downloads the bytes over the remote-aware HTTP boundary (`GET /artifacts/:id`),
 * and materializes them on the *client* filesystem.
 *
 * This is what makes file-producing tools work when the tool-server runs on a
 * different machine than the agent: a `127.0.0.1` URL or a host path is
 * meaningless across the boundary, but an artifact id resolved through
 * `TOOLS_URL` is not.
 */

import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type { Request, Response } from "express";

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
   * Absolute path of the file on this (tool-server) host. A co-located client
   * uses it to read the file directly instead of downloading it over
   * `/artifacts/:id`. The client verifies it against `size`/`mtimeMs` first, so
   * a remote client (where the path is meaningless or absent) simply falls back
   * to the download route.
   */
  hostPath: string;
  /** mtime of `hostPath` (ms) at registration, for the client's integrity check. */
  mtimeMs?: number;
}

interface ArtifactEntry {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
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
};

function inferMimeType(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export interface RegisterArtifactOptions {
  /** Override the basename presented to the client. Defaults to the host basename. */
  filename?: string;
  /** Override the inferred MIME type. */
  mimeType?: string;
}

/**
 * Process-global registry. The tool-server is a single process, so a module
 * singleton is sufficient: the screenshot tool registers an entry and the
 * `/artifacts/:id` route — running in the same process — resolves it later.
 */
class ArtifactRegistry {
  private readonly entries = new Map<string, ArtifactEntry>();

  async register(hostPath: string, opts?: RegisterArtifactOptions): Promise<ArtifactHandle> {
    const filename = opts?.filename ?? basename(hostPath);
    const mimeType = opts?.mimeType ?? inferMimeType(hostPath);
    let size = 0;
    let mtimeMs: number | undefined;
    try {
      const st = await stat(hostPath);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      // File may be produced lazily or be a bundle directory; size/mtime are
      // advisory. A co-located client re-stats and falls back to download if
      // they don't match what's on disk at read time.
    }
    const id = randomUUID();
    this.entries.set(id, { path: hostPath, filename, mimeType, size });
    const handle: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id,
      filename,
      mimeType,
      size,
      hostPath,
    };
    if (mtimeMs != null) handle.mtimeMs = mtimeMs;
    return handle;
  }

  get(id: string): ArtifactEntry | undefined {
    return this.entries.get(id);
  }
}

let singleton: ArtifactRegistry | null = null;

export function getArtifactRegistry(): ArtifactRegistry {
  if (!singleton) singleton = new ArtifactRegistry();
  return singleton;
}

/**
 * Express handler for `GET /artifacts/:id`. Streams the registered file with
 * its content type. 404 if the id is unknown, 410 if the file has since
 * vanished from the host filesystem.
 */
export async function handleArtifactRequest(req: Request, res: Response): Promise<void> {
  const id = req.params.id!;
  const entry = getArtifactRegistry().get(id);
  if (!entry) {
    res.status(404).json({ error: `Artifact "${id}" not found` });
    return;
  }
  try {
    await access(entry.path);
  } catch {
    res
      .status(410)
      .json({ error: `Artifact "${id}" file no longer exists on the tool-server host` });
    return;
  }

  res.setHeader("Content-Type", entry.mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${entry.filename}"`);
  if (entry.size > 0) res.setHeader("Content-Length", String(entry.size));

  const stream = createReadStream(entry.path);
  stream.on("error", () => {
    if (!res.headersSent) res.status(500).json({ error: `Failed to read artifact "${id}"` });
    else res.destroy();
  });
  stream.pipe(res);
}
