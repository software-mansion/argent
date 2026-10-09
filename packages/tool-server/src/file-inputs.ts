/**
 * Server-side resolution of file-input wrappers — the INPUT half of the
 * remote file boundary (the OUTPUT half is `artifacts.ts`).
 *
 * Turns each {@link FileInputWire} the client sent back into a plain
 * server-readable string *before* zod validation, so tools always execute
 * against a local path:
 *
 * - `kind: "file"`: inlined content (sent only by a linked client, or built
 *   by the flow runner from the bytes a client sent for a `tool:` step) is
 *   materialized into a temp file, even when the path also matches on this
 *   host; without content, a path that matches on this host's own filesystem
 *   is used in place — zero copies.
 * - `kind: "tar-upload"` is extracted from a streamed tar whenever `uploadId`
 *   is set, even if the path also exists on this host, and otherwise used in
 *   place.
 * - `kind: "directory"` is used in place, and fails with remote-mode guidance
 *   when absent here (a tree can't ride in a tool call).
 * - `kind: "probe"` passes through and only reports presence.
 * - A `collect` spec's `members` (a flow's `run:` closure, its nested flows,
 *   the snapshot baselines of its runs and its `tool:` steps' file arguments,
 *   sent with the flow by a linked client, or the files one recorded step
 *   reads) are decoded with the same checks, each into its own state: a
 *   member that the client did not send fails only where it is used. A
 *   member whose bytes fail those checks fails the call, as a declared input
 *   does.
 *
 * Plain string args (older clients, direct invocations) pass through untouched.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import bytesUtil from "bytes";
import { safeExtractTarGz } from "@argent/archive";
import {
  isFileInputWire,
  type FileInputMember,
  type FileInputSpec,
  type FileInputWire,
  type OnDiskSpelling,
  type ResolvedFileInput,
  type ResolvedMember,
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

/** Hands over a pending upload at most once; the caller then owns its tar. */
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

/** Refuse uploaded bytes that exceed the limit or disagree with the client's size. */
function checkUploadSize(wire: Pick<FileInputWire, "path" | "size">, bytes: number): void {
  if (bytes > MAX_UPLOAD_BYTES) {
    throw new FileInputError(
      `Uploaded file "${wire.path}" is ${bytes} bytes — exceeds the ` +
        `${MAX_UPLOAD_BYTES}-byte file-input limit.`
    );
  }
  // A client-recorded size disagreeing with the received bytes means the upload
  // was truncated or mangled in transit — fail rather than hand the tool a
  // corrupt file.
  if (wire.size != null && bytes !== wire.size) {
    throw new FileInputError(
      `Uploaded content for "${wire.path}" is ${bytes} bytes but the client ` +
        `recorded ${wire.size} — refusing a truncated or corrupted upload.`
    );
  }
}

/** Decode inlined content, refusing what exceeds the limit or disagrees with the client's size. */
function decodeContent(wire: Pick<FileInputWire, "path" | "size" | "content">): Buffer {
  const data = Buffer.from(wire.content!, "base64");
  checkUploadSize(wire, data.length);
  return data;
}

/** Write uploaded content into a fresh OS temp dir; returns the file path and the dir to remove on cleanup. */
async function materializeUpload(wire: FileInputWire): Promise<{ filePath: string; dir: string }> {
  const data = decodeContent(wire);
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

function isSpelling(value: unknown): value is OnDiskSpelling {
  if (typeof value !== "object" || value === null) return false;
  const { state, actual, addressable } = value as Record<string, unknown>;
  if (state === "listed" || state === "absent") return true;
  return state === "case_folded" && typeof actual === "string" && typeof addressable === "boolean";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Add a flow member's bytes to the total of its call before they are read. The
 * text of each flow member stays in memory for the whole run, so the flow
 * members of a call get the limit of one file together, however many the call
 * names. A baseline or a tool file is written to a temp file, so it does not count.
 */
function countMemberBytes(member: FileInputMember, taken: { bytes: number }, bytes: number): void {
  taken.bytes += bytes;
  if (taken.bytes > MAX_UPLOAD_BYTES) {
    throw new FileInputError(
      `The members of this call are ${taken.bytes} bytes together with "${member.path}". ` +
        `This exceeds the ${MAX_UPLOAD_BYTES}-byte limit for the members of one call.`
    );
  }
}

/**
 * Where one member's bytes land on this host, checked the way a declared file
 * input's are, or undefined when the client sent neither content nor an
 * upload for it. Bytes that fail a check, or an upload that is gone, throw the
 * {@link FileInputError} of a declared input.
 */
async function materializeMember(
  member: FileInputMember,
  tempDirs: string[],
  lookupUpload: UploadLookup | undefined
): Promise<string | undefined> {
  const wire = member as unknown as FileInputWire;
  if (typeof member.content === "string") {
    const { filePath, dir } = await materializeUpload(wire);
    tempDirs.push(dir);
    return filePath;
  }
  if (typeof member.uploadId !== "string") return undefined;
  const unused: ResolvedFileInput = {
    clientPath: member.path,
    presentOnHost: false,
    viaUpload: true,
  };
  const { value } = await extractTarUpload(wire, member.uploadId, unused, tempDirs, lookupUpload);
  return value;
}

/** A flow member's text: decoded in memory when inline (see {@link materializeMember}). */
async function memberText(
  member: FileInputMember,
  tempDirs: string[],
  lookupUpload: UploadLookup | undefined,
  taken: { bytes: number }
): Promise<string | undefined> {
  if (typeof member.content === "string") {
    const data = decodeContent(member);
    countMemberBytes(member, taken, data.length);
    return data.toString("utf8");
  }
  const file = await materializeMember(member, tempDirs, lookupUpload);
  if (file === undefined) return undefined;
  const unreadable = (err: unknown): never => {
    throw new FileInputError(
      `Could not read the uploaded file "${member.path}": ${errorText(err)}`
    );
  };
  // A small archive can expand to far more than the limit, so the size on disk
  // is checked before the bytes are read into memory.
  const { size } = await stat(file).catch(unreadable);
  checkUploadSize(member, size);
  countMemberBytes(member, taken, size);
  return readFile(file, "utf8").catch(unreadable);
}

/**
 * Resolve a wire's members by key. An entry that the client did not send is
 * never an error of the call: a malformed one becomes `refused`, so the step
 * that needs it fails, and nothing else. An entry whose transfer failed (its
 * bytes fail the checks of a declared input, or its upload is gone) fails the
 * call with that upload error, as a declared input does: the flow is fine,
 * its transfer is not. So does a flow entry that takes the flow members past
 * the limit of one file together. An entry of a role this server does not know
 * is left out, as is a repeated key after its first entry. A flow is kept as
 * text; a baseline or a tool file is written to a temp file (`hostPath`), or
 * kept as `listed` when the client sent its name only.
 */
async function resolveMembers(
  members: unknown[],
  tempDirs: string[],
  lookupUpload: UploadLookup | undefined
): Promise<Record<string, ResolvedMember>> {
  const out: Record<string, ResolvedMember> = {};
  const taken = { bytes: 0 };
  for (const raw of members) {
    if (typeof raw !== "object" || raw === null) continue;
    const member = raw as FileInputMember;
    if (
      (member.role !== "flow" && member.role !== "baseline" && member.role !== "tool") ||
      typeof member.key !== "string" ||
      Object.hasOwn(out, member.key)
    ) {
      continue;
    }
    const flow = member.role === "flow";
    if (
      (flow && (typeof member.canonical !== "string" || !isSpelling(member.spelling))) ||
      (flow && member.state === "listed")
    ) {
      out[member.key] = {
        role: member.role,
        state: "refused",
        canonical: String(member.path),
        spelling: { state: "listed" },
        error: "the client sent an invalid entry for it",
      };
      continue;
    }
    const base: Pick<ResolvedMember, "role" | "canonical" | "spelling"> = flow
      ? { role: member.role, canonical: member.canonical, spelling: member.spelling }
      : { role: member.role };
    if (member.state === "missing" || member.state === "listed") {
      out[member.key] = { ...base, state: member.state };
    } else if (member.state === "refused") {
      out[member.key] = {
        ...base,
        state: "refused",
        error: typeof member.error === "string" ? member.error : "the client did not send it",
      };
    } else {
      const sent = flow
        ? { text: await memberText(member, tempDirs, lookupUpload, taken) }
        : { hostPath: await materializeMember(member, tempDirs, lookupUpload) };
      out[member.key] =
        sent.text === undefined && sent.hostPath === undefined
          ? { ...base, state: "refused", error: `the client sent no content for "${member.path}"` }
          : { ...base, state: "present", ...sent };
    }
  }
  return out;
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
    // flow-add-step's probe carries the files its one step reads.
    if (spec.collect === "step" && Array.isArray(wire.members)) {
      meta.members = await resolveMembers(wire.members, tempDirs, lookupUpload);
    }
    return { value: wire.path, meta };
  }

  if (spec.kind === "tar-upload") {
    if (wire.uploadId) {
      return extractTarUpload(wire, wire.uploadId, meta, tempDirs, lookupUpload);
    }
    if (meta.presentOnHost) {
      return { value: wire.path, meta };
    }
    // No stat: the client found nothing at the path, or predates tar uploads.
    throw new FileInputError(
      wire.size == null
        ? `Path "${wire.path}" was not found. The client sent no file for it, and the ` +
            `tool-server host has none at that path.`
        : `Path "${wire.path}" does not exist on the tool-server host and no upload was provided. ` +
            `Update argent to a version that supports uploads for remote sessions.`
    );
  }

  // The client inlines content only when it is linked, and then its bytes are
  // the latest: a host file that matches the stat may be a mirrored copy (cp -p
  // and tar keep size and mtime) of an older revision, beside siblings that are
  // older still. Like a tar-upload's uploadId, uploaded content wins.
  if (spec.kind === "file" && typeof wire.content === "string") {
    const { filePath, dir } = await materializeUpload(wire);
    tempDirs.push(dir);
    const uploaded: ResolvedFileInput = {
      clientPath: wire.path,
      presentOnHost: probe.present,
      viaUpload: true,
    };
    if (
      spec.collect === "flow" &&
      Array.isArray(wire.members) &&
      typeof wire.canonical === "string" &&
      isSpelling(wire.spelling)
    ) {
      uploaded.canonical = wire.canonical;
      uploaded.spelling = wire.spelling;
      uploaded.members = await resolveMembers(wire.members, tempDirs, lookupUpload);
    }
    return { value: filePath, meta: uploaded };
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
 * Remove each upload that a declared wire in `body` names, its members
 * included, and that resolution did not take: the call failed before it, or
 * did not need it. An upload serves only the call that names it, so it must
 * not stay on disk and count toward the pending limit until the sweeper runs.
 */
async function releaseUploads(
  specs: FileInputSpec[],
  body: Record<string, unknown>,
  lookupUpload: UploadLookup | undefined
): Promise<void> {
  const ids: unknown[] = [];
  for (const spec of specs) {
    const wire = body[spec.target];
    if (!isFileInputWire(wire)) continue;
    ids.push(wire.uploadId);
    if (!Array.isArray(wire.members)) continue;
    for (const member of wire.members as unknown[]) {
      if (typeof member === "object" && member !== null) {
        ids.push((member as FileInputMember).uploadId);
      }
    }
  }
  await Promise.all(
    ids.map(async (id) => {
      const entry = typeof id === "string" ? lookupUpload?.(id) : undefined;
      if (entry) await rm(entry.tarPath, { force: true }).catch(() => {});
    })
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
  } finally {
    await releaseUploads(specs, body as Record<string, unknown>, lookupUpload);
  }

  return { args, fileInputs: resolved, derivedTargets, cleanup };
}
