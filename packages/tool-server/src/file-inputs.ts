/**
 * Server-side resolution of file-input wrappers — the INPUT half of the
 * remote file boundary (the OUTPUT half is `artifacts.ts`).
 *
 * Turns each {@link FileInputWire} the client sent back into a plain
 * server-readable string *before* zod validation, so tools always execute
 * against a local path:
 *
 * - co-located client: the wrapper's path matches on this host's own
 *   filesystem and is used in place — zero copies.
 * - remote client: `kind: "file"` content is materialized into a temp file;
 *   `kind: "directory"` fails with remote-mode guidance (a tree can't ride in
 *   a tool call); `kind: "tar-upload"` is extracted from a streamed tar
 *   whenever `uploadId` is set, even if the path also exists on this host;
 *   `kind: "probe"` passes through and only reports presence.
 *
 * Plain string args (older clients, direct invocations) pass through untouched.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import bytesUtil from "bytes";
import { safeExtractTarGz } from "@argent/archive";
import {
  isFileInputWire,
  type FileInputSpec,
  type FileInputWire,
  type ResolvedFileInput,
  type ToolDefinition,
} from "@argent/registry";

/**
 * Decoded per-file upload ceiling. Must stay below the express.json body limit
 * in `http.ts`, which bounds the base64-encoded request as a whole.
 */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Typed so the HTTP layer can map it to a 422 instead of a generic 500. */
export class FileInputError extends Error {}

/** Pending tar-upload archive, keyed by uploadId. */
export interface UploadEntry {
  tarPath: string;
  /** SHA-256 hex digest of the tarball bytes, computed while receiving POST /upload. */
  sha256: string;
}

type UploadLookup = (uploadId: string) => UploadEntry | undefined;

interface ResolveFileInputsResult {
  /** The request body, with file-input wrappers resolved away. */
  args: Record<string, unknown>;
  /** Per-target outcomes, forwarded via `InvokeToolOptions.fileInputs`. */
  fileInputs: Record<string, ResolvedFileInput> | undefined;
  /**
   * Targets the client built out of other params (`flow_file`) rather than the
   * caller naming them, so an error message can leave them out of the keys it
   * reads back.
   */
  derivedTargets: string[];
  /**
   * Removes the temp files this call materialized. Uploads are call-scoped —
   * nothing may reference them after the response — so the caller must invoke
   * this once the call settles. A no-op when everything resolved in place;
   * removal failures are swallowed.
   */
  cleanup: () => Promise<void>;
}

/**
 * `present`: the wrapper's path is usable on THIS host. `directory` and `probe`
 * only need to exist (size/mtime are meaningless there); `file` and
 * `tar-upload` must match the client-recorded stat, so a stale or unrelated
 * file at the same path falls through to the upload path instead of being read
 * by accident. `statVerified` is the strong form — the wire carried both stat
 * fields and the host file matched both — because presence alone is satisfiable
 * by a hand-crafted stat-less wrapper and must not serve as containment.
 */
async function probeHostPath(
  wire: FileInputWire,
  kind: FileInputSpec["kind"]
): Promise<{ present: boolean; statVerified: boolean }> {
  const miss = { present: false, statVerified: false };
  try {
    const st = await stat(wire.path);
    if (kind === "directory") return { present: st.isDirectory(), statVerified: false };
    if (kind === "probe") return { present: true, statVerified: false };
    if (kind === "tar-upload" && st.isDirectory()) {
      if (wire.mtimeMs != null && Math.round(st.mtimeMs) !== Math.round(wire.mtimeMs)) {
        return miss;
      }
      return { present: true, statVerified: false };
    }
    if (!st.isFile()) return miss;
    if (wire.size != null && st.size !== wire.size) return miss;
    if (wire.mtimeMs != null && Math.round(st.mtimeMs) !== Math.round(wire.mtimeMs)) return miss;
    return { present: true, statVerified: wire.size != null && wire.mtimeMs != null };
  } catch {
    return miss;
  }
}

/**
 * `skipWhenSet` / `unwrapWhenSet` gate: a param counts as set whenever the
 * caller provided it — matching the `=== undefined` checks a tool's own
 * dual-source validation uses, so a degenerate value ("", null) still routes
 * the call to that validation instead of having the boundary vouch for a file
 * the call is not using. A wrapper also counts: a wrapped source param may not
 * be resolved yet when a later spec reads it.
 */
function isParamSet(value: unknown): boolean {
  return value !== undefined;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes == null) return "unknown size";
  return bytesUtil(bytes, { decimalPlaces: 1, unitSeparator: " " }) ?? `${bytes} B`;
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "upload";
}

/** Write uploaded content into a fresh OS temp dir; returns the file path and the dir to remove on cleanup. */
async function materializeUpload(wire: FileInputWire): Promise<{ filePath: string; dir: string }> {
  const data = Buffer.from(wire.content!, "base64");
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new FileInputError(
      `Uploaded file "${wire.path}" is ${data.length} bytes — exceeds the ` +
        `${MAX_UPLOAD_BYTES}-byte file-input limit.`
    );
  }
  // A client-recorded size disagreeing with the decoded bytes means the upload
  // was truncated or mangled in transit — fail rather than hand the tool a
  // corrupt file.
  if (wire.size != null && data.length !== wire.size) {
    throw new FileInputError(
      `Uploaded content for "${wire.path}" is ${data.length} bytes but the client ` +
        `recorded ${wire.size} — refusing a truncated or corrupted upload.`
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "argent-file-input-"));
  const filePath = join(dir, sanitizeFilename(basename(wire.path)));
  await writeFile(filePath, data);
  return { filePath, dir };
}

async function extractTarUpload(
  wire: FileInputWire,
  uploadId: string,
  meta: ResolvedFileInput,
  tempDirs: string[],
  lookupUpload: UploadLookup | undefined
): Promise<{ value: string; meta: ResolvedFileInput }> {
  const entry = lookupUpload?.(uploadId);
  if (!entry) {
    throw new FileInputError(
      `Upload "${wire.uploadId}" was not found on the tool-server — it may have expired. ` +
        `Re-run the tool to upload the path again.`
    );
  }
  // The HTTP layer already removed this entry from the upload registry, so the
  // sweeper and dispose() can no longer reclaim entry.tarPath — remove it on
  // every exit from here, including the hash-check failures below.
  try {
    if (!wire.contentHash) {
      throw new FileInputError(
        `Upload for "${wire.path}" is missing a content hash — update argent to a version ` +
          `that supports tar uploads for remote sessions.`
      );
    }
    if (entry.sha256 !== wire.contentHash) {
      throw new FileInputError(
        `Upload content hash mismatch for "${wire.path}" — the tarball may have been ` +
          `corrupted in transit. Re-run the tool to upload again.`
      );
    }
    const extractDir = await mkdtemp(
      join(tmpdir(), `argent-tar-upload-${entry.sha256.slice(0, 16)}-`)
    );
    tempDirs.push(extractDir);
    const uploaded = await safeExtractTarGz(entry.tarPath, extractDir, basename(wire.path));
    return { value: uploaded, meta: { ...meta, viaUpload: true } };
  } catch (err) {
    if (err instanceof FileInputError) throw err;
    throw new FileInputError(
      `Could not extract the uploaded archive for "${wire.path}": ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    await rm(entry.tarPath, { force: true }).catch(() => {});
  }
}

async function resolveOne(
  spec: FileInputSpec,
  wire: FileInputWire,
  tempDirs: string[],
  lookupUpload: UploadLookup | undefined
): Promise<{ value: string; meta: ResolvedFileInput }> {
  const probe = await probeHostPath(wire, spec.kind);
  const meta: ResolvedFileInput = {
    clientPath: wire.path,
    presentOnHost: probe.present,
    viaUpload: false,
    ...(probe.statVerified ? { statVerified: true } : {}),
  };

  if (spec.kind === "probe") {
    return { value: wire.path, meta };
  }

  if (spec.kind === "tar-upload") {
    if (wire.uploadId) {
      return extractTarUpload(wire, wire.uploadId, meta, tempDirs, lookupUpload);
    }
    if (meta.presentOnHost) {
      return { value: wire.path, meta };
    }
    throw new FileInputError(
      `Path "${wire.path}" does not exist on the tool-server host and no upload was provided. ` +
        `Update argent to a version that supports uploads for remote sessions.`
    );
  }

  if (meta.presentOnHost) {
    return { value: wire.path, meta };
  }

  if (spec.kind === "directory") {
    throw new FileInputError(
      `Directory "${wire.path}" does not exist on the tool-server host. ` +
        `This tool reads a directory tree from the tool-server's filesystem, which cannot be ` +
        `uploaded with the call — when the tool-server runs on a different machine, pass a ` +
        `path that exists on that machine (e.g. the server-side checkout of the project).`
    );
  }

  if (typeof wire.content === "string") {
    const { filePath, dir } = await materializeUpload(wire);
    tempDirs.push(dir);
    return { value: filePath, meta: { ...meta, viaUpload: true } };
  }

  if (wire.contentOmitted === "size-limit") {
    throw new FileInputError(
      `File "${wire.path}" is ${formatBytes(wire.size)} — larger than the ` +
        `${formatBytes(MAX_UPLOAD_BYTES)} file-input transfer limit, so the client did not ` +
        `upload it, and it was not found on the tool-server host. Copy the file to the ` +
        `tool-server machine and pass that path, or use a smaller file.`
    );
  }

  throw new FileInputError(
    `File "${wire.path}" was not found on the tool-server host and the client did not ` +
      `upload its content. Either the file does not exist, or it changed since it was ` +
      `referenced — re-create it (or re-run the producing tool) and try again.`
  );
}

/**
 * Replace every declared file-input wrapper in `body` with a plain
 * server-readable path string. Returns the rewritten args plus per-target
 * resolution metadata. Only declared targets are honored, so clients can't
 * smuggle uploads through undeclared params.
 */
export async function resolveFileInputs(
  def: Pick<ToolDefinition<unknown, unknown>, "fileInputs">,
  body: unknown,
  lookupUpload?: UploadLookup
): Promise<ResolveFileInputsResult> {
  const tempDirs: string[] = [];
  const cleanup = async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {}))
    );
  };

  const specs = def.fileInputs;
  if (!specs || specs.length === 0 || typeof body !== "object" || body === null) {
    return {
      args: (body ?? {}) as Record<string, unknown>,
      fileInputs: undefined,
      derivedTargets: [],
      cleanup,
    };
  }

  const args = { ...(body as Record<string, unknown>) };
  let resolved: Record<string, ResolvedFileInput> | undefined;
  const derivedTargets: string[] = [];

  try {
    for (const spec of specs) {
      const value = args[spec.target];
      if (!isFileInputWire(value)) continue;
      // A path template naming anything but its own target was built by the
      // client, so this key is the client's, not the caller's.
      if (spec.path !== `\${${spec.target}}` && !derivedTargets.includes(spec.target)) {
        derivedTargets.push(spec.target);
      }
      if (spec.unwrapWhenSet !== undefined && isParamSet(args[spec.unwrapWhenSet])) {
        // Caller-authored dual-source: the superseding source param is also
        // set, so the tool's own exactly-one validation must diagnose the
        // call — not this wrapper's resolution (whose outcome hinges on
        // whether the unused file exists), and not a drop (which would
        // rewrite the mistake into a valid single-source call and silently
        // run the other source). No resolution metadata is recorded because
        // nothing was probed.
        args[spec.target] = value.path;
        continue;
      }
      if (spec.skipWhenSet !== undefined && isParamSet(args[spec.skipWhenSet])) {
        // Old-client skew: the client derived and wrapped this target even
        // though the superseding source param is set. Drop the derived wrapper
        // instead of resolving it, so zod sees the call the agent actually
        // made and the tool's own dual-source rule — not this file's
        // existence — diagnoses it. Explicit string values on the target are
        // caller-authored, never wrappers, and pass through above.
        delete args[spec.target];
        continue;
      }
      const { value: path, meta } = await resolveOne(spec, value, tempDirs, lookupUpload);
      args[spec.target] = path;
      resolved = { ...(resolved ?? {}), [spec.target]: meta };
    }
  } catch (err) {
    // A later spec failing must not leak the uploads already written for
    // earlier ones — the caller never gets a result to clean up from.
    await cleanup();
    throw err;
  }

  return { args, fileInputs: resolved, derivedTargets, cleanup };
}
