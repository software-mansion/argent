/**
 * Artifact HTTP transport — the tool-server's `/artifacts/:id` route.
 *
 * The store itself (registration, the id→entry map, the {@link ArtifactHandle}
 * wire contract) lives in `@argent/registry` and is owned by the {@link Registry}
 * (`registry.artifacts`). This module is only the transport: it streams a
 * registered file — or, for a directory bundle, a gzipped tar on demand — to a
 * remote client over `GET /artifacts/:id`. A co-located client never hits this
 * route; it reads the file in place via the handle's `hostPath`.
 *
 * The wire types are re-exported here so existing `../artifacts` importers keep
 * working; new code may import them straight from `@argent/registry`.
 */

import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createTarGzArgs } from "@argent/archive";
import type { Request, Response } from "express";
import type {
  Registry,
  ArtifactEntry,
  ArtifactListItem,
  ArtifactStore,
  ToolContext,
} from "@argent/registry";

export {
  ArtifactStore,
  ARTIFACT_MARKER,
  type ArtifactHandle,
  type ArtifactEntry,
  type ArtifactListItem,
  type ArtifactKind,
  type RegisterArtifactOptions,
} from "@argent/registry";

/**
 * Pull the registry-owned artifact store from a tool's `execute` context.
 * The registry always injects it via `invokeTool`, so this only throws when a
 * tool's `execute` is called directly (bypassing the registry) without a
 * context — i.e. a misconfigured unit test, not a real invocation.
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
 * Build the Express handler for `GET /artifacts/:id`, closed over the registry
 * that owns the store. Streams the registered file with its content type; 404
 * if the id is unknown, 410 if the file has since vanished from the host.
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

    // Directory bundle (e.g. a `.trace`): archive on demand. This only runs when
    // a remote client actually downloads it — local clients use the directory in
    // place via the gate, so we never spend time zipping in local mode.
    if (entry.isDirectory) {
      streamDirectoryAsTarGz(id, entry, res);
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

/**
 * Build the Express handler for `GET /artifacts`. Returns the current
 * in-memory artifact inventory without exposing tool-server host paths.
 */
export function makeArtifactListRoute(registry: Registry) {
  return function handleArtifactListRequest(_req: Request, res: Response): void {
    const artifacts: ArtifactListItem[] = registry.artifacts.list();
    res.json({ artifacts });
  };
}

/**
 * Stream a directory as a gzipped tar via the system `tar` (already relied on
 * for `xctrace` in the same profiling flow). `-C <parent> <base>` keeps the
 * bundle's own directory as the single top-level entry, so the client unpacks
 * it back to `<dir>/<base>`.
 */
function streamDirectoryAsTarGz(id: string, entry: ArtifactEntry, res: Response): void {
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${entry.filename}.tar.gz"`);

  // stdin/stderr are ignored, not piped: an unread stderr pipe can fill its
  // buffer (e.g. tar's "file changed as we read it" warnings on a live trace)
  // and deadlock the child. A truncated archive from a non-zero exit is caught
  // client-side, where extraction fails and the artifact resolves to null.
  const child = spawn("tar", createTarGzArgs(entry.path, "-"), {
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: `Failed to archive artifact "${id}": ${err.message}` });
    } else {
      res.destroy();
    }
  });
  // Don't leave tar running if the client aborts the download mid-stream.
  // `writableFinished` distinguishes an abort from normal completion, so we
  // don't signal an already-finished child on a clean end.
  res.on("close", () => {
    if (!res.writableFinished && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  });
  child.stdout.pipe(res);
}
