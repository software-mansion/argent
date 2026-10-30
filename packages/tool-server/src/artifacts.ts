/**
 * Artifact HTTP transport: streams a registered file — or, for a directory
 * bundle, a compressed tar on demand — to a remote client over `GET /artifacts/:id`.
 * A co-located client never hits this route; it reads the file in place via the
 * handle's `hostPath`.
 *
 * The store itself lives in `@argent/registry`, owned by the {@link Registry}
 * (`registry.artifacts`); its wire types are re-exported here so existing
 * `../artifacts` importers keep working.
 */

import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  ARCHIVE_CONTENT_TYPES,
  archiveFormatsFromAccept,
  createCompressor,
  createTarArgs,
  pickArchiveFormat,
  trackTarEnd,
} from "@argent/archive";
import type { Request, Response } from "express";
import type {
  Registry,
  ArtifactEntry,
  ArtifactListItem,
  ArtifactStore,
  ToolContext,
} from "@argent/registry";

export { ArtifactStore, type ArtifactHandle } from "@argent/registry";

/**
 * Pull the registry-owned artifact store from a tool's `execute` context.
 * Throws only when `execute` is called directly, bypassing `invokeTool`'s
 * injection — a misconfigured unit test, not a real invocation.
 */
export function requireArtifacts(ctx?: Partial<ToolContext>): ArtifactStore {
  if (!ctx?.artifacts) {
    throw new Error(
      "Artifact store missing from tool context. Invoke this tool via registry.invokeTool " +
        "(which injects ctx.artifacts), or pass { artifacts } when calling execute directly."
    );
  }
  return ctx.artifacts;
}

/**
 * Express handler for `GET /artifacts/:id`: 404 if the id is unknown, 410 if the
 * file has since vanished from the host.
 */
export function makeArtifactRoute(registry: Registry) {
  return async function handleArtifactRequest(req: Request, res: Response): Promise<void> {
    const id = req.params.id as string;
    const entry = registry.artifacts.get(id);
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

    // Archive a directory bundle (e.g. a `.trace`) on demand: only a remote
    // download pays for zipping, since local clients use the directory in place
    // via the gate.
    if (entry.isDirectory) {
      streamDirectoryAsArchive(id, entry, req, res);
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
  };
}

/** Express handler for `GET /artifacts`: the inventory, minus host paths. */
export function makeArtifactListRoute(registry: Registry) {
  return function handleArtifactListRequest(_req: Request, res: Response): void {
    const artifacts: ArtifactListItem[] = registry.artifacts.list();
    res.json({ artifacts });
  };
}

/**
 * Stream a directory as a compressed tar: zstd when the request's `Accept` lists
 * `application/zstd`, else gzip. `-C <parent> <base>` keeps the bundle's own
 * directory as the single top-level entry, so the client unpacks it back to
 * `<dir>/<base>`.
 */
function streamDirectoryAsArchive(
  id: string,
  entry: ArtifactEntry,
  req: Request,
  res: Response
): void {
  const format = pickArchiveFormat(archiveFormatsFromAccept(req.headers.accept));
  const ext = format === "zstd" ? "tar.zst" : "tar.gz";
  res.setHeader("Content-Type", ARCHIVE_CONTENT_TYPES[format]);
  res.setHeader("Vary", "Accept");
  res.setHeader("Content-Disposition", `attachment; filename="${entry.filename}.${ext}"`);

  // stderr is ignored, not piped: an unread pipe can fill its buffer (e.g.
  // tar's "file changed as we read it" on a live trace) and deadlock the child.
  const child = spawn("tar", createTarArgs(entry.path), {
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: `Failed to archive artifact "${id}": ${err.message}` });
    } else {
      res.destroy();
    }
  });
  const compressor = createCompressor(format);
  // On a client abort, stop tar and the compressor, which would otherwise stay
  // alive undrained with its buffers; `writableFinished` tells an abort apart
  // from a clean end.
  res.on("close", () => {
    if (res.writableFinished) return;
    compressor.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  // tar can exit non-zero after a whole archive (that live-trace warning), but an
  // abandoned one lacks the end-of-archive marker. The compressor closes a valid
  // frame either way, so destroy the response for the latter: the client's
  // download then fails instead of extracting a partial bundle.
  const tarEnd = trackTarEnd();
  child.stdout.on("data", (chunk: Buffer) => tarEnd.push(chunk));
  const tarClosed = new Promise<number | null>((resolve) => child.on("close", resolve));
  compressor.on("error", () => res.destroy());
  compressor.on("end", () => {
    void tarClosed.then((code) => {
      if (code === 0 || tarEnd.ended()) res.end();
      else res.destroy();
    });
  });
  child.stdout.pipe(compressor).pipe(res, { end: false });
}
