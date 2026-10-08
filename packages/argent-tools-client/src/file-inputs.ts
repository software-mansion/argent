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
 * `.argent/flows/*.yaml` so a misbehaving tool-server cannot write elsewhere.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { createTarGzFile } from "@argent/archive";
import {
  FLOW_FILE_NAME_PATTERN,
  MAX_RUN_DEPTH,
  canonicalFlowPath,
  classifyOnDiskSpelling,
  collectFlowRequests,
  flowMemberKey,
  type FileInputMember,
  type OnDiskSpelling,
} from "@argent/registry";

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
  /** Over a link, also send the flow's `run:` closure as `members` (see {@link collectFlowMembers}). */
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

async function uploadTar(
  tarPath: string,
  endpoint: { url: string; token: string }
): Promise<string> {
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
  };
  const res = await fetch(`${endpoint.url}/upload`, init);
  if (!res.ok) {
    throw new Error(`Upload to ${endpoint.url}/upload failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { uploadId: string };
  return json.uploadId;
}

/** Tar `sourcePath`, stream it to `POST /upload`, and return what the wire names it by. */
async function uploadFile(
  sourcePath: string,
  endpoint: { url: string; token: string }
): Promise<{ uploadId: string; contentHash: string }> {
  const tarPath = path.join(tmpdir(), `argent-upload-${randomUUID()}.tar.gz`);
  trackArchive(tarPath);
  try {
    await createTarGzFile(sourcePath, tarPath);
    const contentHash = await sha256File(tarPath);
    return { uploadId: await uploadTar(tarPath, endpoint), contentHash };
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
async function readFileInputWire(
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
 * Inline member bytes, summed over a call, up to which members ride in the
 * call body; past it each member goes through `POST /upload`, so a proxy's
 * body limit never sees a large closure.
 */
const INLINE_MEMBERS_BYTES = 256 * 1024;

const FLOW_FILES_LOG_ENV = "ARGENT_FLOW_FILES_LOG";

/** `inner` is `outer` or lies under it; both absolute and normalized. */
function isWithin(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
}

/** Escapes control characters, so a name cannot forge a log line. */
function printable(text: string): string {
  return [...text]
    .map((c) =>
      c < " " || c === "\x7f" ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c
    )
    .join("");
}

/** `<P>` for a file under `<P>/.argent/flows/`, the innermost such `<P>`. */
function savedFlowProject(file: string): string | null {
  const parts = file.split(path.sep);
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i] === ".argent" && parts[i + 1] === "flows") {
      return parts.slice(0, i).join(path.sep) || path.sep;
    }
  }
  return null;
}

/**
 * Where `spelled` lands on this machine: its realpath, or, when a component
 * is missing, the realpath of the nearest existing ancestor with the rest
 * appended. `error` is the kernel's refusal other than a missing component
 * (a link loop, a file used as a directory).
 */
async function landing(spelled: string): Promise<{ canonical: string; error?: string }> {
  try {
    return { canonical: await realpath(spelled) };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    const rest: string[] = [];
    let at = spelled;
    for (;;) {
      rest.unshift(path.basename(at));
      const parent = path.dirname(at);
      if (parent === at) return { canonical: spelled };
      const real = await realpath(parent).catch(() => null);
      if (real !== null) {
        const canonical = path.join(real, ...rest);
        return missing ? { canonical } : { canonical, error: (err as Error).message };
      }
      at = parent;
    }
  }
}

/**
 * The directories a flow's closure may come from, as real paths: the project
 * (`project_root`) and its `.argent/flows` (which may be a symlink to a tree
 * elsewhere), the directory of the root flow as spelled and as its real file,
 * and the project of a root flow saved under `<P>/.argent/flows/`, by either
 * path, since the CLI sends its working directory as `project_root`.
 */
async function closureRoots(
  rootPath: string,
  rootCanonical: string,
  projectRoot: unknown
): Promise<string[]> {
  const candidates: string[] = [];
  if (typeof projectRoot === "string" && path.isAbsolute(projectRoot)) {
    candidates.push(projectRoot, path.join(projectRoot, ".argent", "flows"));
  }
  candidates.push(path.dirname(rootPath), path.dirname(rootCanonical));
  for (const file of [rootPath, rootCanonical]) {
    const project = savedFlowProject(file);
    if (project !== null) candidates.push(project);
  }
  const real: string[] = [];
  for (const candidate of candidates) {
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved !== null && !real.includes(resolved)) real.push(resolved);
  }
  // A root inside another root adds no reach; a refusal names the outermost.
  return real.filter((root) => !real.some((other) => other !== root && isWithin(root, other)));
}

/**
 * One `run:` target as the runner will resolve it: beside the real file that
 * names it. Sent only from inside `roots`, and only as a YAML file within the
 * 32 MiB cap; anything else is a `refused` member with the reason, and a
 * target with nothing there a `missing` one. `text` is the file's content, for
 * the walk to read its own targets.
 */
async function readFlowMember(
  anchorDir: string,
  target: string,
  roots: string[],
  budget: { inline: number },
  opts: PrepareFileInputsOptions
): Promise<{ member: FileInputMember; text?: string; sent: string }> {
  const spelled = anchorDir + path.sep + target;
  const { canonical, error } = await landing(spelled);
  const spelling = await classifyOnDiskSpelling(
    path.dirname(spelled),
    path.posix.basename(target),
    FLOW_FILE_NAME_PATTERN
  );
  const member: FileInputMember = {
    role: "flow",
    key: flowMemberKey(anchorDir, target),
    path: spelled,
    canonical,
    spelling,
  };
  const refuse = (reason: string) => ({
    member: { ...member, state: "refused" as const, error: reason },
    sent: `refused (${reason})`,
  });
  if (!roots.some((root) => isWithin(canonical, root))) {
    return refuse(`${target} is outside every root this client serves (${roots.join(", ")})`);
  }
  if (error !== undefined) return refuse(error);
  const st = await stat(canonical).catch((err: NodeJS.ErrnoException) => err);
  if (st instanceof Error) {
    if (st.code !== "ENOENT") return refuse(st.message);
    return { member: { ...member, state: "missing" }, sent: "missing" };
  }
  if (st.isDirectory()) return refuse("EISDIR: illegal operation on a directory, read");
  // A `.yaml` name that links to a file that is not YAML (a `.env`) would
  // send that file; a link to a `.yml` flow is an ordinary layout.
  if (!/\.ya?ml$/i.test(path.basename(canonical))) {
    return refuse(`${target} links to a file that is not a YAML file`);
  }
  const read = await readFileInputWire(canonical, { includeContent: true });
  if (read?.contentOmitted) {
    return refuse(`${canonical} is larger than the 32 MiB cap on a file sent to the tool-server`);
  }
  if (read?.content === undefined) {
    // The wire read keeps no error; read once more for the one a host read
    // would report (EACCES and the like).
    return refuse(
      await readFile(canonical).then(
        () => `${canonical} could not be read on this client`,
        (err: unknown) => (err instanceof Error ? err.message : String(err))
      )
    );
  }
  const text = Buffer.from(read.content, "base64").toString("utf8");
  const size = read.size ?? 0;
  if (budget.inline + size <= INLINE_MEMBERS_BYTES || !opts.uploadEndpoint) {
    budget.inline += size;
    return { member: { ...member, ...read }, text, sent: `inline ${size}` };
  }
  const uploaded = await uploadFile(canonical, opts.uploadEndpoint);
  return {
    member: { ...member, size: read.size, mtimeMs: read.mtimeMs, ...uploaded },
    text,
    sent: `upload ${size}`,
  };
}

/**
 * The `run:` closure of the flow at `rootPath`, sent with its wire: every
 * file a `run:` step of the flow or of a file it reaches names, in breadth
 * order, each resolution once, as deep as the runner resolves
 * ({@link MAX_RUN_DEPTH}). Every branch of a `when:` counts, since which one
 * runs is decided on the device. The targets come from the registry's
 * {@link collectFlowRequests}, which the tool-server's own tests hold to the
 * runner's parse. `canonical` and `spelling` describe the root flow itself.
 */
async function collectFlowMembers(
  rootPath: string,
  rootBytes: Buffer,
  args: Record<string, unknown>,
  opts: PrepareFileInputsOptions
): Promise<Pick<FileInputWire, "canonical" | "spelling" | "members">> {
  const canonical = await canonicalFlowPath(rootPath);
  const spelling = await classifyOnDiskSpelling(
    path.dirname(rootPath),
    path.basename(rootPath),
    FLOW_FILE_NAME_PATTERN
  );
  const roots = await closureRoots(rootPath, canonical, args.project_root);
  const members: FileInputMember[] = [];
  const seen = new Set<string>();
  const budget = { inline: 0 };
  const logging = process.env[FLOW_FILES_LOG_ENV] === "1";
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const queue = [{ canonical, text: rootBytes.toString("utf8"), hop: 0 }];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    let doc: unknown;
    try {
      // The runner's parse; its warnings belong to the run, not to this terminal.
      doc = parseYaml(file.text.trim(), { logLevel: "error" });
    } catch {
      continue;
    }
    const anchorDir = path.dirname(file.canonical);
    for (const target of collectFlowRequests(doc).runTargets) {
      const key = flowMemberKey(anchorDir, target);
      if (seen.has(key)) continue;
      seen.add(key);
      const { member, text, sent } = await readFlowMember(anchorDir, target, roots, budget, opts);
      members.push(member);
      if (logging) log(printable(`[flow-files] flow ${member.canonical}: ${sent}`));
      if (text !== undefined && file.hop + 1 < MAX_RUN_DEPTH) {
        queue.push({ canonical: member.canonical!, text, hop: file.hop + 1 });
      }
    }
  }
  return { canonical, spelling, members };
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
      if (spec.collect === "flow" && opts.includeContent && wire.content !== undefined) {
        Object.assign(
          wire,
          await collectFlowMembers(filePath, Buffer.from(wire.content, "base64"), record, opts)
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
        Object.assign(wire, await uploadFile(filePath, opts.uploadEndpoint));
      }
    }

    out = out ?? { ...record };
    out[spec.target] = wire;
  }

  return out ?? args;
}

export interface AppliedClientFiles {
  /** The result with every directive replaced by the written path (or null). */
  result: unknown;
  /** Paths actually written on this machine. */
  written: string[];
}

/**
 * Trust boundary: the directive path is authored by the tool-server. Flow
 * recording is the only producer today, so writes are confined to an absolute
 * path ending `.argent/flows/<name>.yaml`, with no `..` anywhere. Widen
 * deliberately (and equally conservatively) if another tool needs this channel.
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
 * Deep-walk a tool result, writing every client-file directive to disk and
 * rewriting it to the written path. A directive that fails validation or the
 * write resolves to null, mirroring how the artifact materializer signals a
 * missing file.
 */
export async function applyClientFileDirectives(result: unknown): Promise<AppliedClientFiles> {
  const written: string[] = [];

  async function walk(value: unknown): Promise<unknown> {
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
  return { result: rewritten, written };
}
