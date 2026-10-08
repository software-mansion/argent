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
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { createTarGzFile } from "@argent/archive";
import {
  FLOW_FILE_NAME_PATTERN,
  FLOW_NAME_PATTERN,
  MAX_RUN_DEPTH,
  TOOL_FILE_EXTENSIONS,
  baselineKeyFor,
  canonicalFlowPath,
  classifyOnDiskSpelling,
  collectFlowRequests,
  flowMemberKey,
  hasToolFileExtension,
  isClientFileArgument,
  nestedFlowTarget,
  toolStepFiles,
  type FileInputMember,
  type NestedFlowTarget,
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
  /**
   * Over a link, also send as `members` the files the flow makes the
   * tool-server read ({@link collectFlowMembers}), or, on flow-add-step's
   * probe, the files its one recorded step makes it read
   * ({@link collectStepMembers}).
   */
  collect?: "flow" | "step";
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
   * The file inputs a tool declares, from the same `GET /tools` listing, so a
   * `collect` call sends the file arguments of the flow's `tool:` steps.
   * Without it, no `tool:` step sends a file.
   */
  toolFileInputs?: (tool: string) => readonly FileInputSpec[] | undefined;
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
  const sent = await sendBytes(member, canonical, budget, opts);
  return { ...sent, text: sent.bytes?.toString("utf8") };
}

/**
 * A file argument of a `tool:` step, read as the step spells it. Sent only
 * from inside `roots`, and only when the file it really is also has a
 * {@link TOOL_FILE_EXTENSIONS} name, so a link named like an image cannot send
 * a `.env`. Nothing there, or a file where a directory should be, is a
 * `missing` member; a directory or a file that cannot be read is `refused`.
 */
async function readToolMember(
  file: string,
  roots: string[],
  budget: { inline: number },
  opts: PrepareFileInputsOptions
): Promise<{ member: FileInputMember; sent: string }> {
  const member: FileInputMember = { role: "tool", key: file, path: file };
  const refuse = (reason: string) => ({
    member: { ...member, state: "refused" as const, error: reason },
    sent: `refused (${reason})`,
  });
  const { canonical } = await landing(file);
  if (!roots.some((root) => isWithin(canonical, root))) {
    return refuse(`${file} is outside every root this client serves (${roots.join(", ")})`);
  }
  if (!hasToolFileExtension(canonical)) {
    return refuse(`${file} links to a file that is not one of ${TOOL_FILE_EXTENSIONS.join(", ")}`);
  }
  const st = await stat(canonical).catch((err: NodeJS.ErrnoException) => err);
  if (st instanceof Error) {
    if (st.code === "ENOENT" || st.code === "ENOTDIR") {
      return { member: { ...member, state: "missing" }, sent: "missing" };
    }
    return refuse(st.message);
  }
  if (st.isDirectory()) return refuse("EISDIR: illegal operation on a directory, read");
  return sendBytes(member, canonical, budget, opts);
}

/** The platform whose baselines a compare run reads, when the call names it. */
function callPlatform(args: Record<string, unknown>): string | undefined {
  if (typeof args.device === "string" && args.device.startsWith("chromium-cdp-")) return "chromium";
  if (typeof args.platform !== "string") return undefined;
  // The baseline key folds a remote simulator into `ios` (authoringPlatform).
  return args.platform === "ios-remote" ? "ios" : args.platform;
}

/**
 * What a baseline at `file` (an entry of a baseline directory) is to this
 * client: `ok` (`real` is its real path), `missing` (a link to nothing), or
 * `refused` with the reason. Outside the roots, a `.png` name that links to
 * another kind of file, and, for a read, a directory are refused; for a
 * write, a link to nothing and anything but a regular file are refused too.
 */
async function baselineEntry(
  file: string,
  roots: string[],
  forWrite: boolean
): Promise<
  { state: "ok"; real: string } | { state: "missing" } | { state: "refused"; error: string }
> {
  const { canonical, error } = await landing(file);
  if (!roots.some((root) => isWithin(canonical, root))) {
    return {
      state: "refused",
      error: `${file} is outside every root this client serves (${roots.join(", ")})`,
    };
  }
  if (error !== undefined) return { state: "refused", error };
  const st = await stat(canonical).catch((err: NodeJS.ErrnoException) => err);
  if (st instanceof Error) {
    if (st.code !== "ENOENT") return { state: "refused", error: st.message };
    return forWrite
      ? { state: "refused", error: `${file} is a symbolic link to a missing file` }
      : { state: "missing" };
  }
  if (!canonical.endsWith(".png")) {
    return { state: "refused", error: `${file} links to a file that is not a PNG file` };
  }
  if (forWrite && !st.isFile()) return { state: "refused", error: `${file} is not a regular file` };
  if (st.isDirectory()) {
    return { state: "refused", error: "EISDIR: illegal operation on a directory, read" };
  }
  return st.isFile() ? { state: "ok", real: canonical } : { state: "missing" };
}

/**
 * A member's bytes, read from `real`: inline while the call's inline budget
 * lasts, else through `POST /upload`. A file over the 32 MiB cap, or one that
 * cannot be read, is a `refused` member with the reason.
 */
async function sendBytes(
  member: FileInputMember,
  real: string,
  budget: { inline: number },
  opts: PrepareFileInputsOptions
): Promise<{ member: FileInputMember; sent: string; bytes?: Buffer }> {
  const read = await readFileInputWire(real, { includeContent: true });
  if (read?.contentOmitted) {
    const error = `${real} is larger than the 32 MiB cap on a file sent to the tool-server`;
    return { member: { ...member, state: "refused", error }, sent: `refused (${error})` };
  }
  if (read?.content === undefined) {
    // The wire read keeps no error; read once more for the one a host read
    // would report (EACCES and the like).
    const error = await readFile(real).then(
      () => `${real} could not be read on this client`,
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );
    return { member: { ...member, state: "refused", error }, sent: `refused (${error})` };
  }
  const bytes = Buffer.from(read.content, "base64");
  const size = read.size ?? 0;
  if (budget.inline + size <= INLINE_MEMBERS_BYTES || !opts.uploadEndpoint) {
    budget.inline += size;
    return { member: { ...member, ...read }, sent: `inline ${size}`, bytes };
  }
  const uploaded = await uploadFile(real, opts.uploadEndpoint);
  return {
    member: { ...member, size: read.size, mtimeMs: read.mtimeMs, ...uploaded },
    sent: `upload ${size}`,
    bytes,
  };
}

/**
 * One run whose files a call sends: the call's root flow, or a flow that a
 * nested `tool: flow-execute` step runs. `canonical` and `text` are its root
 * flow file; `flowName` keys its baselines when the file's stem cannot
 * ({@link baselineKeyFor}); `hop` is how deep the runner nests that file;
 * `updates` says whether the run writes its baselines, and `platform` whose
 * baselines a compare run reads ({@link callPlatform}).
 */
interface MemberRun {
  canonical: string;
  text: string;
  flowName: string;
  hop: number;
  updates: boolean;
  platform: string | undefined;
}

/**
 * Whether a nested run updates its baselines: when its step says so, and,
 * when the step does not say, when the run that starts it does, as the runner
 * dispatches it.
 */
function nestedRunUpdates(parentUpdates: boolean, args: Record<string, unknown>): boolean {
  return args.updateBaselines === true || (parentUpdates && args.updateBaselines === undefined);
}

/**
 * Collects the members of one call: each flow by its key, each file argument
 * of a `tool:` step by its path and each baseline once, in the order they are
 * found, inline while the call's budget lasts and through `POST /upload`
 * after it, and logs each under `ARGENT_FLOW_FILES_LOG=1`.
 */
function memberCollector(roots: string[], opts: PrepareFileInputsOptions) {
  const members: FileInputMember[] = [];
  const flows = new Map<string, { member: FileInputMember; text?: string }>();
  const tools = new Set<string>();
  const runs = new Set<string>();
  // Each baseline directory a run keys its snapshots in: the snapshot name
  // prefixes a compare run reads, and whether a run of the call updates it.
  const baselineDirs = new Map<string, { prefixes: Set<string>; updates: boolean }>();
  const budget = { inline: 0 };
  const logging = process.env[FLOW_FILES_LOG_ENV] === "1";
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const emit = (member: FileInputMember, sent: string): void => {
    members.push(member);
    const subject = member.role === "flow" ? member.canonical : member.key;
    if (logging) log(printable(`[flow-files] ${member.role} ${subject}: ${sent}`));
  };

  /** The flow that `target` names beside `anchorDir`, sent once ({@link readFlowMember}). */
  async function flow(
    anchorDir: string,
    target: string
  ): Promise<{ member: FileInputMember; text?: string }> {
    const key = flowMemberKey(anchorDir, target);
    const known = flows.get(key);
    if (known !== undefined) return known;
    const { member, text, sent } = await readFlowMember(anchorDir, target, roots, budget, opts);
    const entry = { member, ...(text === undefined ? {} : { text }) };
    flows.set(key, entry);
    emit(member, sent);
    return entry;
  }

  /**
   * The file arguments of a `tool:` step: the arguments its tool declares as
   * a `file` input, at an absolute path with a {@link TOOL_FILE_EXTENSIONS}
   * name ({@link isClientFileArgument}), each path once, as spelled. A nested
   * flow is not a file argument the runner reads for its tool.
   */
  async function toolFiles(step: { tool: string; args: Record<string, unknown> }): Promise<void> {
    if (step.tool === "flow-execute") return;
    for (const file of toolStepFiles(opts.toolFileInputs?.(step.tool), step.args)) {
      // An input whose superseding param is also set stays unread: the
      // tool's own validation refuses the call.
      const { unwrapWhenSet } = file.spec;
      if (unwrapWhenSet !== undefined && step.args[unwrapWhenSet] !== undefined) continue;
      if (!isClientFileArgument(file) || tools.has(file.path)) continue;
      tools.add(file.path);
      const read = await readToolMember(file.path, roots, budget, opts);
      emit(read.member, read.sent);
    }
  }

  /** The run of the flow that a nested step names, when the flow was sent and the runner nests that deep. */
  async function nestedRun(
    target: Extract<NestedFlowTarget, { kind: "name" }>,
    hop: number,
    updates: boolean,
    platform: string | undefined
  ): Promise<MemberRun | undefined> {
    const { member, text } = await flow(path.dirname(target.path), `${target.name}.yaml`);
    if (text === undefined || hop >= MAX_RUN_DEPTH) return undefined;
    return { canonical: member.canonical!, text, flowName: target.name, hop, updates, platform };
  }

  /**
   * The files of `start` and of every run it nests: per run, every file a
   * `run:` step of its root flow or of a file it reaches names, in breadth
   * order, each resolution once per run, as deep as the runner resolves
   * ({@link MAX_RUN_DEPTH}, nested runs counted). Every branch of a `when:`
   * counts, since which one runs is decided on the device. The file
   * arguments of the `tool:` steps of those files, and the flow each nested
   * `tool: flow-execute` step names by `name` (the one form the runner runs),
   * whose run is walked the same way. The snapshots of a run key the
   * baselines of that run, sent by {@link sendBaselines}.
   */
  async function walk(start: MemberRun[]): Promise<void> {
    const queue = [...start];
    for (let run = queue.shift(); run !== undefined; run = queue.shift()) {
      const id = [run.canonical, run.flowName, run.updates, run.platform ?? ""].join("\0");
      if (runs.has(id)) continue;
      runs.add(id);
      const snapshots = new Set<string>();
      const visited = new Set<string>();
      const files = [{ canonical: run.canonical, text: run.text, hop: run.hop }];
      for (let file = files.shift(); file !== undefined; file = files.shift()) {
        let doc: unknown;
        try {
          // The runner's parse; its warnings belong to the run, not to this terminal.
          doc = parseYaml(file.text.trim(), { logLevel: "error" });
        } catch {
          continue;
        }
        const requests = collectFlowRequests(doc);
        for (const name of requests.snapshots) snapshots.add(name);
        for (const step of requests.toolSteps) await toolFiles(step);
        const anchorDir = path.dirname(file.canonical);
        for (const target of requests.runTargets) {
          const key = flowMemberKey(anchorDir, target);
          if (visited.has(key)) continue;
          visited.add(key);
          const { member, text } = await flow(anchorDir, target);
          if (text !== undefined && file.hop + 1 < MAX_RUN_DEPTH) {
            files.push({ canonical: member.canonical!, text, hop: file.hop + 1 });
          }
        }
        // The runner binds its own device into a nested step, so the nested
        // run compares on the platform of the run that starts it.
        for (const { target, args } of requests.nested) {
          if (target.kind !== "name") continue;
          const next = await nestedRun(
            target,
            file.hop + 1,
            nestedRunUpdates(run.updates, args),
            run.platform
          );
          if (next !== undefined) queue.push(next);
        }
      }
      if (snapshots.size === 0) continue;
      const dir = path.join(
        path.dirname(run.canonical),
        "__baselines__",
        baselineKeyFor(run.canonical, run.flowName)
      );
      const entry = baselineDirs.get(dir) ?? { prefixes: new Set<string>(), updates: false };
      baselineDirs.set(dir, entry);
      if (run.updates) {
        entry.updates = true;
      } else {
        const platform = run.platform === undefined ? "" : `${run.platform}-`;
        for (const name of snapshots) entry.prefixes.add(`${name}__${platform}`);
      }
    }
  }

  /**
   * The snapshot baselines of the runs, from each run's
   * `<dir of its root flow's real file>/__baselines__/<key>/`, where the
   * runner keys them ({@link baselineKeyFor}). A run that compares reads the
   * baselines of its own snapshots only (`<snapshot>__*.png`, crops
   * included), of one platform when its call names it, so those go with their
   * bytes. A run that updates baselines never reads one, so every other
   * `.png` there goes by name only (`listed`), for the runner to say whether a
   * write replaced one; the directory of such a run is one where a baseline
   * in the result may be written (`baselineDirs`). A directory outside the
   * roots sends nothing and takes no write. A baseline already sent as the
   * file argument of a `tool:` step is not sent twice.
   */
  async function sendBaselines(): Promise<void> {
    for (const [dir, { prefixes, updates }] of baselineDirs) {
      const real = (await landing(dir)).canonical;
      if (!roots.some((root) => isWithin(real, root))) continue;
      if (updates) opts.baselineDirs?.push(dir);
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names.sort()) {
        if (!name.endsWith(".png")) continue;
        const compared = [...prefixes].some((prefix) => name.startsWith(prefix));
        if (!updates && !compared) continue;
        const file = path.join(dir, name);
        if (tools.has(file)) continue;
        const member: FileInputMember = { role: "baseline", key: file, path: file };
        const entry = await baselineEntry(file, roots, updates && !compared);
        if (entry.state === "refused") {
          emit({ ...member, state: "refused", error: entry.error }, `refused (${entry.error})`);
        } else if (entry.state === "missing") {
          emit({ ...member, state: "missing" }, "missing");
        } else if (!compared) {
          emit({ ...member, state: "listed" }, "listed");
        } else {
          const sent = await sendBytes(member, entry.real, budget, opts);
          emit(sent.member, sent.sent);
        }
      }
    }
  }

  return { members, flow, toolFiles, nestedRun, walk, sendBaselines };
}

/**
 * The project files the flow at `rootPath` makes the runner read, sent with
 * its wire: the files of its run and of each run it nests
 * ({@link memberCollector}), then the snapshot baselines of those runs. The
 * targets, snapshot names, tool steps and nested flows come from the
 * registry's {@link collectFlowRequests}, which the tool-server's own tests
 * hold to the runner's parse. `canonical` and `spelling` describe the root
 * flow itself.
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
  const collector = memberCollector(
    await closureRoots(rootPath, canonical, args.project_root),
    opts
  );
  await collector.walk([
    {
      canonical,
      text: rootBytes.toString("utf8"),
      flowName: path.basename(rootPath, ".yaml"),
      hop: 0,
      updates: args.updateBaselines === true,
      platform: callPlatform(args),
    },
  ]);
  await collector.sendBaselines();
  return { canonical, spelling, members: collector.members };
}

/**
 * The step a `flow-add-step` call runs and records: its `command`, with
 * `args` parsed from the JSON text of an object, or `{}` when the call has no
 * `args`. Undefined for any other `command` or `args`: no step runs with them.
 */
function recordedStep(
  args: Record<string, unknown>
): { tool: string; args: Record<string, unknown> } | undefined {
  const { command, args: text } = args;
  if (typeof command !== "string") return undefined;
  if (text === undefined) return { tool: command, args: {} };
  if (typeof text !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return { tool: command, args: parsed as Record<string, unknown> };
}

/**
 * The project files the one step a `flow-add-step` call records makes the
 * tool-server read, as a replay of that step over a link reads them: the file
 * arguments of the step, and for a nested `flow-execute`, the flow it names
 * with the files of its run ({@link memberCollector}) and the baselines of
 * that run. The recorder also resolves the recording file
 * `<project_root>/.argent/flows/<name>.yaml` for its real directory, and the
 * sibling `<name>.yaml` there, which a nested flow is recorded as a `run:`
 * step of only when it is the flow that ran. A `flow_path` the recorder
 * rewrites to that sibling's name (it is a file in the recording's
 * directory) is sent under its own spelling too, for the recorder's on-disk
 * spelling check, and its run as the name the recorder runs it by. Nothing
 * for a call without a valid `name` and absolute `project_root`, or whose
 * step does not parse.
 */
async function collectStepMembers(
  args: Record<string, unknown>,
  opts: PrepareFileInputsOptions
): Promise<FileInputMember[]> {
  const { name, project_root: projectRoot } = args;
  const step = recordedStep(args);
  if (
    typeof name !== "string" ||
    !FLOW_NAME_PATTERN.test(name) ||
    typeof projectRoot !== "string" ||
    !path.isAbsolute(projectRoot) ||
    step === undefined
  ) {
    return [];
  }
  const recording = path.join(projectRoot, ".argent", "flows", `${name}.yaml`);
  const collector = memberCollector(
    await closureRoots(recording, (await landing(recording)).canonical, projectRoot),
    opts
  );
  await collector.toolFiles(step);
  if (step.tool === "flow-execute") {
    const self = await collector.flow(path.dirname(recording), path.basename(recording));
    let runArgs = step.args;
    const named = nestedFlowTarget(runArgs);
    if (named?.kind === "flow_path") {
      const stem = path.basename(named.path, ".yaml");
      if (path.resolve(path.dirname(named.path)) === path.resolve(path.dirname(recording))) {
        await collector.flow(path.dirname(recording), path.basename(named.path));
        runArgs = { ...runArgs, name: stem };
        delete runArgs.flow_path;
      }
    }
    const target = nestedFlowTarget(runArgs);
    if (target?.kind === "name") {
      await collector.flow(path.dirname(self.member.canonical!), `${target.name}.yaml`);
      const run = await collector.nestedRun(
        target,
        0,
        runArgs.updateBaselines === true,
        callPlatform(runArgs)
      );
      if (run !== undefined) await collector.walk([run]);
    }
  }
  await collector.sendBaselines();
  return collector.members;
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

    if (spec.kind === "probe" && spec.collect === "step" && opts.includeContent) {
      wire.members = await collectStepMembers(record, opts);
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
