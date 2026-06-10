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
 *   a tool call); `kind: "probe"` passes through and only reports presence.
 *
 * Plain string args (older clients, direct invocations) pass through untouched,
 * which is what keeps both halves of the version-skew matrix on today's
 * behavior.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
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

/** Typed so the HTTP layer can map it to a 422 instead of a generic 500. */
export class FileInputError extends Error {}

export interface ResolveFileInputsResult {
  /** The request body with every wrapper replaced by a plain path string. */
  args: Record<string, unknown>;
  /** Per-target outcomes, forwarded to the tool via `InvokeToolOptions.fileInputs`. */
  fileInputs: Record<string, ResolvedFileInput> | undefined;
}

/**
 * True when the wrapper's path is usable on THIS host. `directory` only needs
 * to exist as a directory and `probe` to exist at all (size/mtime are
 * meaningless there); a `file` must match the client-recorded stat so a stale
 * or unrelated file at the same path — or a remote host that merely mirrors
 * the directory layout — falls through to the uploaded content instead of
 * being read by accident. A same-stat match on a genuinely different machine
 * means a synced checkout, where reading the server's identical copy is the
 * intended outcome.
 */
async function probeHostPath(wire: FileInputWire, kind: FileInputSpec["kind"]): Promise<boolean> {
  try {
    const st = await stat(wire.path);
    if (kind === "directory") return st.isDirectory();
    if (kind === "probe") return true;
    if (!st.isFile()) return false;
    if (wire.size != null && st.size !== wire.size) return false;
    if (wire.mtimeMs != null && Math.round(st.mtimeMs) !== Math.round(wire.mtimeMs)) return false;
    return true;
  } catch {
    return false;
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "upload";
}

/** Write uploaded content under the OS temp dir and return the file path. */
async function materializeUpload(wire: FileInputWire): Promise<string> {
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
  const dir = join(tmpdir(), "argent-file-inputs", randomUUID());
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, sanitizeFilename(basename(wire.path)));
  await writeFile(filePath, data);
  return filePath;
}

async function resolveOne(
  spec: FileInputSpec,
  wire: FileInputWire
): Promise<{ value: string; meta: ResolvedFileInput }> {
  const meta: ResolvedFileInput = {
    clientPath: wire.path,
    presentOnHost: await probeHostPath(wire, spec.kind),
    viaUpload: false,
  };

  if (spec.kind === "probe" || meta.presentOnHost) {
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
    const value = await materializeUpload(wire);
    return { value, meta: { ...meta, viaUpload: true } };
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
  body: unknown
): Promise<ResolveFileInputsResult> {
  const specs = def.fileInputs;
  if (!specs || specs.length === 0 || typeof body !== "object" || body === null) {
    return { args: (body ?? {}) as Record<string, unknown>, fileInputs: undefined };
  }

  const args = { ...(body as Record<string, unknown>) };
  let resolved: Record<string, ResolvedFileInput> | undefined;

  for (const spec of specs) {
    const value = args[spec.target];
    if (!isFileInputWire(value)) continue;
    const { value: path, meta } = await resolveOne(spec, value);
    args[spec.target] = path;
    resolved = { ...(resolved ?? {}), [spec.target]: meta };
  }

  return { args, fileInputs: resolved };
}
