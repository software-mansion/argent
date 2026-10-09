/**
 * Client half of the INPUT-side file boundary (`artifacts.ts` is the OUTPUT side).
 *
 * {@link prepareFileInputs} interpolates each `fileInputs` spec advertised by
 * `GET /tools`, stats the file on THIS machine, and replaces the target arg
 * with a `__argentFileInput` wrapper. The tool-server materializes the inlined
 * base64, which is sent only to a routed tool-server so local sessions skip the
 * encoding; without it, the tool-server reads the path in place.
 *
 * {@link applyClientFileDirectives} is the reverse: a `__argentClientFile`
 * directive (e.g. a recorded flow YAML) is written here, constrained to
 * `.argent/flows/*.yaml` so a misbehaving tool-server cannot write elsewhere,
 * or, for a base64 snapshot baseline, to the baseline directories the client
 * itself computed for the call.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import * as path from "node:path";

import { createTarGzFile } from "@argent/archive";
import {
  FAILURE_CODES,
  FLOW_FILE_NAME_PATTERN,
  type FileInputMember,
  type OnDiskSpelling,
} from "@argent/registry";

import { ToolInvocationError } from "./errors.js";

/** Must match the wire contract in `@argent/registry`'s file-inputs.ts. */
export const FILE_INPUT_MARKER = "__argentFileInput" as const;
export const CLIENT_FILE_MARKER = "__argentClientFile" as const;

export type FileInputKind = "file" | "directory" | "probe" | "tar-upload";

/** One declared file-boundary arg, as advertised by `GET /tools`. */
export interface FileInputSpec {
  target: string;
  path: string;
  kind: FileInputKind;
  optional?: boolean;
  /**
   * Skip this spec when the named param is set — it is an alternate source
   * that supersedes this template, so `target` must not be derived alongside
   * it (the tool's own validation diagnoses dual-source calls).
   */
  skipWhenSet?: string;
  /**
   * Over a link, also send the flow's `run:` closure and its run's snapshot
   * baselines as `members` (see `collectMembers`).
   */
  collect?: "flow";
}

export interface FileInputWire {
  [FILE_INPUT_MARKER]: true;
  path: string;
  size?: number;
  mtimeMs?: number;
  content?: string;
  /** Readable content deliberately not inlined; "size-limit" = over MAX_CONTENT_BYTES. */
  contentOmitted?: "size-limit";
  uploadId?: string;
  /** SHA-256 hex digest of the streamed tarball; the server verifies it before extracting. */
  contentHash?: string;
  canonical?: string;
  spelling?: OnDiskSpelling;
  members?: FileInputMember[];
}

export interface ClientFileDirective {
  [CLIENT_FILE_MARKER]: true;
  path: string;
  content: string;
  /** `base64`: a snapshot baseline, written only into a baseline directory of the call. */
  encoding?: "base64";
}

/**
 * Mirrors the server's decoded-upload limit. A larger file is sent as a
 * stat-only wrapper marked `contentOmitted: "size-limit"`: it still resolves
 * in place co-located, and a remote server without the file reports the
 * transfer limit instead of this client dying on a huge encode.
 */
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;

export interface PrepareFileInputsOptions {
  /**
   * Inline file bytes for `kind: "file"` wrappers. True when routed to an
   * external tool-server (`argent link` / ARGENT_TOOLS_URL); false keeps the
   * wrapper path-only for the co-located fast path.
   */
  includeContent: boolean;
  /**
   * Set only when routed to a remote tool-server: `kind: "tar-upload"` inputs
   * are tarballed and streamed to `POST <url>/upload` before the tool call.
   * Absent for co-located sessions (the server reads the path in place).
   */
  uploadEndpoint?: { url: string; token: string };
  /**
   * Receives the `[flow-files]` lines that `ARGENT_FLOW_FILES_LOG=1` turns on,
   * one for each member a `collect` spec sends. Defaults to stderr.
   */
  log?: (line: string) => void;
  /**
   * Filled with the baseline directory of each run a `collect` call updates
   * baselines for: the only places {@link applyClientFileDirectives} writes a
   * baseline the result returns (its `allowedDirs`).
   */
  baselineDirs?: string[];
  /**
   * Builds the `members` of a `collect` spec over a link (the tools client
   * passes flow-files.ts's collector). Without it the spec sends its file only.
   */
  collectMembers?: (
    rootPath: string,
    rootBytes: Buffer,
    args: Record<string, unknown>,
    opts: PrepareFileInputsOptions
  ) => Promise<Pick<FileInputWire, "canonical" | "spelling" | "members">>;
  /** Stops the upload. */
  signal?: AbortSignal;
}

/**
 * Interpolate a spec's `${param}` path template from string args. Null when a
 * referenced param is absent — the spec doesn't apply to this call
 * (required-param errors belong to the tool's own validation).
 */
function interpolatePath(template: string, args: Record<string, unknown>): string | null {
  let missing = false;
  const out = template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
    const v = args[name];
    if (typeof v !== "string" || v.length === 0) {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? null : out;
}

// Archives of the uploads in progress. A signal or `process.exit()` ends the
// process without the `finally` that removes an archive, so listeners remove
// them while any exists. A signal is then raised again for its default action.
const pendingArchives = new Set<string>();
const ARCHIVE_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function removePendingArchives(): void {
  for (const archive of pendingArchives) {
    try {
      rmSync(archive, { force: true });
    } catch {
      // Best effort: the process is ending.
    }
  }
  pendingArchives.clear();
  for (const s of ARCHIVE_SIGNALS) process.removeListener(s, removeArchivesOnSignal);
  process.removeListener("exit", removePendingArchives);
}

function removeArchivesOnSignal(signal: NodeJS.Signals): void {
  removePendingArchives();
  // A listener replaces the signal's default action. When no other code
  // handles the signal, raise it again so the process ends as it would have.
  if (process.listenerCount(signal) > 0) return;
  try {
    process.kill(process.pid, signal);
  } catch {
    // Windows cannot raise every signal (SIGHUP among them): exit with the
    // code that the signal gives.
    process.exit(128 + constants.signals[signal]);
  }
}

function trackArchive(archive: string): void {
  if (pendingArchives.size === 0) {
    for (const s of ARCHIVE_SIGNALS) process.on(s, removeArchivesOnSignal);
    process.on("exit", removePendingArchives);
  }
  pendingArchives.add(archive);
}

function untrackArchive(archive: string): void {
  if (!pendingArchives.delete(archive) || pendingArchives.size > 0) return;
  for (const s of ARCHIVE_SIGNALS) process.removeListener(s, removeArchivesOnSignal);
  process.removeListener("exit", removePendingArchives);
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/**
 * The `error` of a reply that the tool-server itself sent: a JSON object with
 * `error` as its only field. A proxy's JSON error page has more fields.
 */
function toolServerError(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    const { error, ...rest } = body as { error?: unknown };
    return typeof error === "string" && Object.keys(rest).length === 0 ? error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why `POST /upload` refused an archive of `bytes` bytes. A 413 that the
 * tool-server did not send comes from a proxy that limits the size of a
 * request body, so the error names the size that the proxy must accept.
 * The call that needs the upload is not sent, so the error is a rejection of
 * that call alone (kind "validation"): the tool did not run.
 */
function uploadFailure(
  url: string,
  res: Response,
  text: string,
  bytes: number
): ToolInvocationError {
  const status = `${res.status} ${res.statusText}`.trim();
  const own = toolServerError(text);
  let detail = own === undefined ? "" : `: ${own}`;
  if (own === undefined && res.status === 413) {
    const mb = Math.max(1, Math.ceil(bytes / (1024 * 1024)));
    detail =
      `. A proxy between the client and the tool-server limits the size of a request body. ` +
      `The proxy must accept a body of at least ${mb} MB on POST /upload, for example ` +
      `client_max_body_size ${mb}m in nginx`;
  }
  return new ToolInvocationError(`Upload to ${url}/upload failed: ${status}${detail}`, {
    errorCode: FAILURE_CODES.FILE_INPUT_UPLOAD_FAILED,
    errorKind: "validation",
  });
}

async function uploadTar(
  tarPath: string,
  endpoint: { url: string; token: string },
  signal?: AbortSignal
): Promise<string> {
  const { size } = await stat(tarPath);
  // `duplex: "half"` is required to stream a Node Readable request body via
  // undici's fetch, but it isn't in the DOM RequestInit type.
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      "content-type": "application/gzip",
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
    },
    body: createReadStream(tarPath) as unknown as BodyInit,
    duplex: "half",
    signal,
  };
  const res = await fetch(`${endpoint.url}/upload`, init);
  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch {
      // The status alone still says what failed.
    }
    throw uploadFailure(endpoint.url, res, text, size);
  }
  const json = (await res.json()) as { uploadId: string };
  return json.uploadId;
}

/** Tar `sourcePath`, stream it to `POST /upload`, and return what the wire names it by. */
export async function uploadFile(
  sourcePath: string,
  endpoint: { url: string; token: string },
  signal?: AbortSignal
): Promise<{ uploadId: string; contentHash: string }> {
  const tarPath = path.join(tmpdir(), `argent-upload-${randomUUID()}.tar.gz`);
  trackArchive(tarPath);
  try {
    await createTarGzFile(sourcePath, tarPath);
    const contentHash = await sha256File(tarPath);
    return { uploadId: await uploadTar(tarPath, endpoint, signal), contentHash };
  } finally {
    untrackArchive(tarPath);
    await rm(tarPath, { force: true }).catch(() => {});
  }
}

/**
 * Stat and, when asked, read one `kind: "file"` input as the wire carries it.
 * Null when the path cannot be stat'ed or is not a regular file. With
 * `includeContent`, a file within MAX_CONTENT_BYTES carries its bytes as
 * base64; a larger one carries `contentOmitted: "size-limit"` instead, so an
 * absent-on-server path errors with the transfer limit rather than misleading
 * "file not found" guidance, and the stat fields stay for in-place resolution.
 * A file that stats but cannot be read keeps the stat fields and no content.
 *
 * Shared by a declared input and a member of its closure, so both are read
 * alike.
 */
export async function readFileInputWire(
  filePath: string,
  opts: { includeContent: boolean }
): Promise<Pick<FileInputWire, "size" | "mtimeMs" | "content" | "contentOmitted"> | null> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const out: Pick<FileInputWire, "size" | "mtimeMs" | "content" | "contentOmitted"> = {
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
  if (opts.includeContent && st.size <= MAX_CONTENT_BYTES) {
    try {
      out.content = (await readFile(filePath)).toString("base64");
    } catch {
      // Stat fields alone describe the file; the caller decides what an
      // unreadable one means for it.
    }
  } else if (opts.includeContent) {
    out.contentOmitted = "size-limit";
  }
  return out;
}

/**
 * Replace declared file-path args with boundary wrappers. Returns the same
 * args reference when no spec applies, so callers can pass everything through.
 */
export async function prepareFileInputs(
  specs: FileInputSpec[] | undefined,
  args: unknown,
  opts: PrepareFileInputsOptions
): Promise<unknown> {
  if (!specs || specs.length === 0 || typeof args !== "object" || args === null) {
    return args;
  }
  const record = args as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;

  for (const spec of specs) {
    // Deriving this target too would have the boundary vouch for a file the
    // call is not using, letting its existence preempt the tool's dual-source
    // validation. Any provided value counts, matching the `=== undefined`
    // presence checks that validation uses, so a degenerate value ("") is
    // still diagnosed by the tool, not by the boundary.
    if (spec.skipWhenSet && record[spec.skipWhenSet] !== undefined) continue;
    if (spec.target in record && typeof record[spec.target] !== "string") continue;
    const filePath = interpolatePath(spec.path, record);
    if (filePath === null) continue;
    // When the target IS a source param the interpolated path equals its
    // value; a derived target (flow_file) is wrapped only when unset.
    if (spec.target in record && record[spec.target] !== filePath) continue;

    const wire: FileInputWire = { [FILE_INPUT_MARKER]: true, path: filePath };
    if (spec.kind === "file") {
      // Unreadable here (null) keeps the path-only wrapper, which still
      // resolves if the server has the file, and errors precisely otherwise.
      const read = await readFileInputWire(filePath, { includeContent: opts.includeContent });
      if (read) Object.assign(wire, read);
      // Only a routed call sends the closure: co-located, the tool-server
      // reads every file in place.
      if (
        spec.collect === "flow" &&
        opts.includeContent &&
        wire.content !== undefined &&
        opts.collectMembers
      ) {
        Object.assign(
          wire,
          await opts.collectMembers(filePath, Buffer.from(wire.content, "base64"), record, opts)
        );
      }
    }

    if (spec.kind === "tar-upload") {
      const st = await stat(filePath).catch(() => null);
      if (st) {
        wire.size = st.size;
        wire.mtimeMs = st.mtimeMs;
      }

      if (opts.uploadEndpoint && st) {
        // stderr, not stdout (MCP owns it), so a slow upload isn't silent.
        process.stderr.write(`Uploading ${path.basename(filePath)} to the remote tool-server...\n`);
        Object.assign(wire, await uploadFile(filePath, opts.uploadEndpoint, opts.signal));
      }
    }

    out = out ?? { ...record };
    out[spec.target] = wire;
  }

  return out ?? args;
}

export interface AppliedClientFiles {
  /**
   * The result with every directive replaced by the written path (or null);
   * a baseline that was not written by `{ path, error }`.
   */
  result: unknown;
  /** Paths actually written on this machine. */
  written: string[];
  /** Baselines that were not written, and why. */
  failed: { path: string; error: string }[];
}

/**
 * Trust boundary: the directive path is authored by the tool-server. Flow
 * recording is the only producer of text directives, so they are confined to
 * an absolute path ending `.argent/flows/<name>.yaml`, with no `..` anywhere.
 * Widen deliberately (and equally conservatively) if another tool needs this
 * channel.
 */
function isAllowedClientFilePath(p: string): boolean {
  if (!path.isAbsolute(p)) return false;
  const segments = p.split(/[\\/]+/);
  if (segments.includes("..")) return false;
  const file = segments[segments.length - 1] ?? "";
  if (!FLOW_FILE_NAME_PATTERN.test(file)) return false;
  return segments[segments.length - 3] === ".argent" && segments[segments.length - 2] === "flows";
}

function isClientFileDirective(value: unknown): value is ClientFileDirective {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>)[CLIENT_FILE_MARKER] === true &&
    typeof (value as ClientFileDirective).path === "string" &&
    typeof (value as ClientFileDirective).content === "string"
  );
}

/**
 * Replace `target` in one step: write a temporary file beside it, give that
 * file the mode of the one it replaces, and rename it over `target`. A client
 * killed mid-write leaves the old file whole, and at worst a stray dotfile.
 * The temporary file is removed when a step fails. Its name does not grow
 * with the baseline's, so a name near the length limit still gets one.
 */
async function replaceFile(target: string, bytes: Buffer, mode: number | undefined): Promise<void> {
  const temp = path.join(path.dirname(target), `.baseline-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    if (mode !== undefined) await chmod(temp, mode & 0o777);
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/**
 * Write one baseline the result returns, or say why not. Only a `.png` file
 * directly inside one of `allowedDirs`, the baseline directories the client
 * computed for the call, in normal form with no `..`. A `.png` name that is a
 * link must lead to a PNG file in the same real directory; a link to nothing
 * and anything but a regular file are refused, as a host write would not
 * replace them. The file is replaced in one rename, over its real path.
 */
async function writeBaselineFile(
  file: string,
  bytes: Buffer,
  allowedDirs: readonly string[]
): Promise<string | null> {
  if (
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    file.split(/[\\/]/).includes("..") ||
    !file.endsWith(".png") ||
    !allowedDirs.includes(path.dirname(file))
  ) {
    return allowedDirs.length === 0
      ? "this call writes no baselines"
      : `${file} is not a baseline of this call (${allowedDirs.map((d) => `${d}/<name>.png`).join(", ")})`;
  }
  if (bytes.length > MAX_CONTENT_BYTES) {
    return `${file}: the baseline is larger than the 32 MiB cap on a file this client writes`;
  }
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const link = await lstat(file).catch(() => null);
  const real = link === null ? null : await realpath(file).catch(() => null);
  if (link !== null && real === null) return `${file} is a symbolic link to a missing file`;
  if (real !== null) {
    if (!real.endsWith(".png")) return `${file} links to a file that is not a PNG file`;
    if (path.dirname(real) !== (await realpath(dir))) {
      return `${file} links outside its baseline directory`;
    }
  }
  const existing = real === null ? null : await stat(real);
  if (existing !== null && !existing.isFile()) return `${file} is not a regular file`;
  await replaceFile(
    real ?? path.join(await realpath(dir), path.basename(file)),
    bytes,
    existing?.mode
  );
  return null;
}

/**
 * Deep-walk a tool result, writing every client-file directive to disk and
 * rewriting it to the written path. A text directive that fails validation or
 * the write resolves to null, mirroring how the artifact materializer signals
 * a missing file. A base64 directive is a snapshot baseline: written only
 * into `opts.allowedDirs` ({@link writeBaselineFile}), and one that is not
 * written becomes `{ path, error }` and an entry of `failed`, so the caller
 * can report it.
 */
export async function applyClientFileDirectives(
  result: unknown,
  opts: { allowedDirs?: readonly string[] } = {}
): Promise<AppliedClientFiles> {
  const written: string[] = [];
  const failed: { path: string; error: string }[] = [];

  async function walk(value: unknown): Promise<unknown> {
    if (isClientFileDirective(value) && value.encoding === "base64") {
      const error = await writeBaselineFile(
        value.path,
        Buffer.from(value.content, "base64"),
        opts.allowedDirs ?? []
      ).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      if (error !== null) {
        failed.push({ path: value.path, error });
        return { path: value.path, error };
      }
      written.push(value.path);
      return value.path;
    }
    if (isClientFileDirective(value)) {
      if (!isAllowedClientFilePath(value.path)) return null;
      try {
        await mkdir(path.dirname(value.path), { recursive: true });
        await writeFile(value.path, value.content, "utf8");
        written.push(value.path);
        return value.path;
      } catch {
        return null;
      }
    }
    if (Array.isArray(value)) {
      // One at a time, so the writes and their reports keep the result's order.
      const out: unknown[] = [];
      for (const item of value) out.push(await walk(item));
      return out;
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
  return { result: rewritten, written, failed };
}
