/**
 * Artifact materializer — the client side of the remote file boundary.
 *
 * Tool results from the (possibly remote) tool-server carry {@link ArtifactHandle}
 * markers in place of host paths. This module deep-walks a result, downloads
 * each artifact over the remote-aware `TOOLS_URL` (`GET /artifacts/:id`), writes
 * it into a structured cache under the OS temp dir, and rewrites the marker to
 * the **local** path the agent can actually open.
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
 * - session  — minted once per argent-mcp process, so re-runs don't pile into
 *              one bucket and old sessions are trivially GC-able.
 * - device   — udid / serial when the artifact is device-scoped; omitted
 *              otherwise.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

/** Must match the tool-server's wire contract (`tool-server/src/artifacts.ts`). */
export const ARTIFACT_MARKER = "__argentArtifact" as const;

export interface ArtifactHandle {
  [ARTIFACT_MARKER]: true;
  id: string;
  filename: string;
  mimeType: string;
  size: number;
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
 * Walk `result`, download any artifact handles into the local cache, and
 * return the rewritten result plus any image artifacts. A handle whose
 * download fails is rewritten to `null` so the agent sees a missing-file
 * signal rather than a dangling remote reference.
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
      try {
        const res = await fetchFn(`${ctx.toolsUrl}/artifacts/${value.id}`);
        if (!res.ok) return null;
        const data = Buffer.from(await res.arrayBuffer());
        await ensureDir();
        const localPath = join(dir, sanitizeSegment(value.filename));
        await writeFile(localPath, data);
        if (value.mimeType.startsWith("image/")) {
          images.push({ localPath, data, mimeType: value.mimeType });
        }
        return localPath;
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
