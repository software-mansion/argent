/**
 * Server-side resolution of file-input wrappers — the INPUT half of the
 * remote file boundary (the OUTPUT half is `artifacts.ts`).
 *
 * The client replaces args declared in a tool's `fileInputs` with
 * {@link FileInputWire} wrappers (path + stat + optional base64 content). This
 * module turns each wrapper back into a plain server-readable string *before*
 * zod validation, so tools always execute against a local path:
 *
 * - co-located client (the common, unlinked case): the wrapper's path matches
 *   on this host's own filesystem and is used in place — zero copies, exactly
 *   mirroring the artifact materializer's gate on the client side.
 * - remote client: `kind: "file"` content is materialized into a temp file;
 *   `kind: "directory"` fails with remote-mode guidance (a tree can't ride in
 *   a tool call); `kind: "tar-upload"` is extracted from a streamed tar when
 *   `uploadId` is set (always, even if the path also exists on this host);
 *   `kind: "probe"` passes through and only reports presence.
 *
 * Plain string args (older clients, direct invocations) pass through untouched,
 * which is what keeps both halves of the version-skew matrix on today's
 * behavior.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import bytesUtil from "bytes";
import {
  isFileInputWire,
  type FileInputSpec,
  type FileInputWire,
  type ResolvedFileInput,
  type ToolDefinition,
} from "@argent/registry";

/**
 * Decoded upload ceiling. Large enough for full-resolution PNG baselines and
 * any flow YAML; small enough that a misbehaving client can't fill the temp
 * dir through a single call. Must stay below the express.json body limit in
 * `http.ts` (which bounds the base64-encoded request as a whole).
 */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
/** Bounds member count so a zip-style tar can't exhaust handles mid-extract. */
const MAX_TAR_MEMBERS = 10_000;

const execFileAsync = promisify(execFile);

/** Typed so the HTTP layer can map it to a 422 instead of a generic 500. */
export class FileInputError extends Error {}

/** Resolved tar-upload entry, keyed by uploadId. */
export interface UploadEntry {
  tarPath: string;
  /** SHA-256 hex digest of the tarball bytes, computed while receiving POST /upload. */
  sha256: string;
}

export type UploadLookup = (uploadId: string) => UploadEntry | undefined;

export interface ResolveFileInputsResult {
  /** The request body with every wrapper replaced by a plain path string. */
  args: Record<string, unknown>;
  /** Per-target outcomes, forwarded to the tool via `InvokeToolOptions.fileInputs`. */
  fileInputs: Record<string, ResolvedFileInput> | undefined;
  /**
   * Removes every temp file this call materialized. Uploads are call-scoped —
   * the tool reads them during execution and nothing may reference them after
   * the response, so the caller must invoke this once the call settles.
   * Always safe: a no-op when everything resolved in place, and removal
   * failures are swallowed (cleanup must never affect the call's outcome).
   */
  cleanup: () => Promise<void>;
}

/**
 * True when the wrapper's path is usable on THIS host. `directory` only needs
 * to exist as a directory and `probe` to exist at all (size/mtime are
 * meaningless there); `file` and `tar-upload` must match the client-recorded
 * stat so a stale or unrelated file at the same path falls through to the
 * upload path instead of being read by accident.
 */
async function probeHostPath(wire: FileInputWire, kind: FileInputSpec["kind"]): Promise<boolean> {
  try {
    const st = await stat(wire.path);
    if (kind === "directory") return st.isDirectory();
    if (kind === "probe") return true;
    if (kind === "tar-upload") {
      if (st.isDirectory()) {
        if (wire.mtimeMs != null && Math.round(st.mtimeMs) !== Math.round(wire.mtimeMs)) {
          return false;
        }
        return true;
      }
      if (!st.isFile()) return false;
      if (wire.size != null && st.size !== wire.size) return false;
      if (wire.mtimeMs != null && Math.round(st.mtimeMs) !== Math.round(wire.mtimeMs)) {
        return false;
      }
      return true;
    }
    if (!st.isFile()) return false;
    if (wire.size != null && st.size !== wire.size) return false;
    if (wire.mtimeMs != null && Math.round(st.mtimeMs) !== Math.round(wire.mtimeMs)) return false;
    return true;
  } catch {
    return false;
  }
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
  // Integrity: a size recorded client-side that disagrees with the decoded
  // bytes means the upload was truncated or mangled in transit — fail loudly
  // rather than handing the tool a corrupt file.
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

function normalizeTarMemberPath(memberPath: string): string {
  return memberPath.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** Reject tar-slip paths (absolute, `..`, or resolving outside extractDir). */
function isSafeTarMember(memberPath: string, extractDir: string): boolean {
  const normalized = normalizeTarMemberPath(memberPath);
  if (!normalized || normalized === "." || normalized === "./") return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized)) return false;
  const relative = posix.normalize(normalized);
  if (relative === ".." || relative.startsWith("../") || relative.split("/").includes("..")) {
    return false;
  }
  const root = resolve(extractDir);
  const resolved = resolve(extractDir, relative);
  return resolved === root || resolved.startsWith(root + sep);
}

async function listTarMembers(tarPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("tar", ["-tzf", tarPath]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function assertSafeTarArchive(tarPath: string, extractDir: string): Promise<void> {
  let members: string[];
  try {
    members = await listTarMembers(tarPath);
  } catch (err) {
    throw new FileInputError(
      `Failed to read uploaded archive: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (members.length === 0) {
    throw new FileInputError("Uploaded archive is empty.");
  }
  if (members.length > MAX_TAR_MEMBERS) {
    throw new FileInputError(
      `Uploaded archive exceeds the ${MAX_TAR_MEMBERS}-member limit.`
    );
  }
  for (const member of members) {
    if (!isSafeTarMember(member, extractDir)) {
      throw new FileInputError(
        `Uploaded archive contains an unsafe path "${member}" — refusing extraction.`
      );
    }
  }
}

async function safeExtractTar(tarPath: string, extractDir: string): Promise<void> {
  await assertSafeTarArchive(tarPath, extractDir);
  await execFileAsync("tar", ["-xzf", tarPath, "-C", extractDir]);
}

async function extractTarUpload(
  wire: FileInputWire,
  meta: ResolvedFileInput,
  tempDirs: string[],
  lookupUpload: UploadLookup | undefined
): Promise<{ value: string; meta: ResolvedFileInput }> {
  if (!wire.uploadId) {
    throw new FileInputError(
      `Path "${wire.path}" does not exist on the tool-server host and no upload was provided. ` +
        `Update argent to a version that supports uploads for remote sessions.`
    );
  }
  const entry = lookupUpload?.(wire.uploadId);
  if (!entry) {
    throw new FileInputError(
      `Upload "${wire.uploadId}" was not found on the tool-server — it may have expired. ` +
        `Re-run the tool to upload the path again.`
    );
  }
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
  const hashPrefix = entry.sha256.slice(0, 16);
  const extractDir = await mkdtemp(join(tmpdir(), `argent-tar-upload-${hashPrefix}-`));
  tempDirs.push(extractDir);
  // The sweeper no longer owns this tar, so remove it even if extraction throws.
  try {
    await safeExtractTar(entry.tarPath, extractDir);
  } finally {
    await rm(entry.tarPath, { force: true }).catch(() => {});
  }
  // The client tars a single top-level member named after the path's basename.
  // Match it exactly (readdir order is unspecified), falling back to the first
  // real entry when the name doesn't survive the round-trip (e.g. unicode
  // NFC/NFD normalization).
  const entries = await readdir(extractDir);
  const expected = basename(wire.path);
  const uploaded = entries.find((e) => e === expected) ?? entries.find((e) => !e.startsWith("._"));
  if (!uploaded) {
    throw new FileInputError(`Extracted archive for "${wire.path}" is empty.`);
  }
  return { value: join(extractDir, uploaded), meta: { ...meta, viaUpload: true } };
}

async function resolveOne(
  spec: FileInputSpec,
  wire: FileInputWire,
  tempDirs: string[],
  lookupUpload: UploadLookup | undefined
): Promise<{ value: string; meta: ResolvedFileInput }> {
  const meta: ResolvedFileInput = {
    clientPath: wire.path,
    presentOnHost: await probeHostPath(wire, spec.kind),
    viaUpload: false,
  };

  if (spec.kind === "probe") {
    return { value: wire.path, meta };
  }

  if (spec.kind === "tar-upload") {
    if (wire.uploadId) {
      return extractTarUpload(wire, meta, tempDirs, lookupUpload);
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
 * resolution metadata. Wrappers are only honored on declared targets — a
 * wrapper anywhere else simply fails the tool's own schema validation, so
 * clients can't smuggle uploads through undeclared params.
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
    return { args: (body ?? {}) as Record<string, unknown>, fileInputs: undefined, cleanup };
  }

  const args = { ...(body as Record<string, unknown>) };
  let resolved: Record<string, ResolvedFileInput> | undefined;

  try {
    for (const spec of specs) {
      const value = args[spec.target];
      if (!isFileInputWire(value)) continue;
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

  return { args, fileInputs: resolved, cleanup };
}
