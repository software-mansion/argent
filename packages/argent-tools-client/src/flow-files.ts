/**
 * The flow half of the INPUT-side file boundary: the files a `collect: "flow"`
 * file input sends with the flow over a link (see `file-inputs.ts` for the
 * generic wire, upload and directive code). {@link collectFlowMembers} walks
 * the flow's `run:` closure, the file arguments of its `tool:` steps and its
 * run's snapshot baselines on THIS machine and returns them as the wire's
 * `members`, each one inline, uploaded, listed by name, or with the state that
 * tells the tool-server why it was not sent.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

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
  toolStepFiles,
  type FileInputMember,
} from "@argent/registry";

import {
  readFileInputWire,
  uploadFile,
  type FileInputWire,
  type PrepareFileInputsOptions,
} from "./file-inputs.js";

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

/** An absolute path with no `..` segment, as the tool-server requires. */
function isResolvedAbsolute(value: unknown): value is string {
  return (
    typeof value === "string" && path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..")
  );
}

/**
 * The tool-server's own shape rules for the flow a call names: `project_root`
 * absolute with no `..` segment, and exactly one of `flow_path` (the same,
 * named `<flow-name>.yaml`) and `name` (a flow name). The tool-server refuses
 * any other call before step 1, and roots taken from its arguments could
 * reach past the project, so such a call sends none of the flow's files.
 */
function namesValidFlow(args: Record<string, unknown>): boolean {
  const { project_root, flow_path, name } = args;
  if (!isResolvedAbsolute(project_root)) return false;
  if (name === undefined) {
    return isResolvedAbsolute(flow_path) && FLOW_FILE_NAME_PATTERN.test(path.basename(flow_path));
  }
  return flow_path === undefined && typeof name === "string" && FLOW_NAME_PATTERN.test(name);
}

/**
 * `<P>` for a file under `<P>/.argent/flows/`, the innermost such `<P>`. Null
 * for a relative path, where an empty `<P>` is not the filesystem root.
 */
function savedFlowProject(file: string): string | null {
  if (!path.isAbsolute(file)) return null;
  const parts = file.split(path.sep);
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i] === ".argent" && parts[i + 1] === "flows") {
      return parts.slice(0, i).join(path.sep) || path.sep;
    }
  }
  return null;
}

/**
 * How `spelled` resolves on this machine. `canonical` is its realpath, or, when
 * it does not resolve, the host's name for it ({@link canonicalFlowPath}), so a
 * missing fragment fails its step with the text of a co-located run. `fence` is
 * where the kernel's lookup ends, for the root fence: the realpath, or the
 * first component it cannot resolve, beside the realpath of its parent. The
 * lookup stops there, so a `..` after a missing directory leads nowhere:
 * `x/../a.yaml` with no `x` is missing, whatever `a.yaml` is. `missing` is the
 * kernel's ENOENT; `error` is any other refusal (a link loop, a file used as a
 * directory).
 */
async function landing(
  spelled: string
): Promise<{ canonical: string; fence: string; missing?: true; error?: string }> {
  try {
    const canonical = await realpath(spelled);
    return { canonical, fence: canonical };
  } catch (err) {
    const failure =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? { missing: true as const }
        : { error: (err as Error).message };
    const canonical = await canonicalFlowPath(spelled);
    let at = spelled;
    for (;;) {
      const parent = path.dirname(at);
      if (parent === at) return { canonical, fence: spelled, ...failure };
      const real = await realpath(parent).catch(() => null);
      if (real !== null) {
        return { canonical, fence: path.join(real, path.basename(at)), ...failure };
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
  const { canonical, fence, missing, error } = await landing(spelled);
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
  if (!roots.some((root) => isWithin(fence, root))) {
    return refuse(`${target} is outside every root this client serves (${roots.join(", ")})`);
  }
  if (error !== undefined) return refuse(error);
  if (missing) return { member: { ...member, state: "missing" }, sent: "missing" };
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
  const uploaded = await uploadFile(real, opts.uploadEndpoint, opts.signal);
  return {
    member: { ...member, size: read.size, mtimeMs: read.mtimeMs, ...uploaded },
    sent: `upload ${size}`,
    bytes,
  };
}

/**
 * The snapshot baselines of the run of the root flow at `canonical`, from
 * `<its dir>/__baselines__/<key>/`, where the runner keys them
 * ({@link baselineKeyFor}). A run that updates baselines never reads one, so
 * each `.png` there goes by name only (`listed`), for the runner to say
 * whether a write replaced one; its directory is the only place a baseline
 * in the result may be written. A run that compares gets the bytes of the
 * baselines of its own snapshots only (`<snapshot>__*.png`, crops included),
 * of one platform when the call names it ({@link callPlatform}). A directory
 * outside the roots sends nothing and takes no write. A baseline already in
 * `sent`, as the file argument of a `tool:` step, is not sent twice.
 */
async function collectBaselineMembers(
  canonical: string,
  flowName: string,
  snapshots: string[],
  args: Record<string, unknown>,
  roots: string[],
  budget: { inline: number },
  opts: PrepareFileInputsOptions,
  sent: ReadonlySet<string>,
  emit: (member: FileInputMember, sent: string) => void
): Promise<void> {
  const dir = path.join(
    path.dirname(canonical),
    "__baselines__",
    baselineKeyFor(canonical, flowName)
  );
  const real = (await landing(dir)).canonical;
  if (!roots.some((root) => isWithin(real, root))) return;
  const updates = args.updateBaselines === true;
  if (updates) opts.baselineDirs?.push(dir);
  const platform = callPlatform(args);
  const prefixes = snapshots.map(
    (name) => `${name}__${platform === undefined ? "" : `${platform}-`}`
  );
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.sort()) {
    if (!name.endsWith(".png")) continue;
    if (!updates && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const file = path.join(dir, name);
    if (sent.has(file)) continue;
    const member: FileInputMember = { role: "baseline", key: file, path: file };
    const entry = await baselineEntry(file, roots, updates);
    if (entry.state === "refused") {
      emit({ ...member, state: "refused", error: entry.error }, `refused (${entry.error})`);
    } else if (entry.state === "missing") {
      emit({ ...member, state: "missing" }, "missing");
    } else if (updates) {
      emit({ ...member, state: "listed" }, "listed");
    } else {
      const sent = await sendBytes(member, entry.real, budget, opts);
      emit(sent.member, sent.sent);
    }
  }
}

/**
 * The project files the flow at `rootPath` makes the runner read, sent with
 * its wire. Its `run:` closure: every file a `run:` step of the flow or of a
 * file it reaches names, in breadth order, each resolution once, as deep as
 * the runner resolves ({@link MAX_RUN_DEPTH}). Every branch of a `when:`
 * counts, since which one runs is decided on the device. The file arguments
 * of the `tool:` steps of those files ({@link readToolMember}): the arguments
 * that the tool declares as a `file` input, at an absolute path with a
 * {@link TOOL_FILE_EXTENSIONS} name, each path once, as spelled. Then the
 * snapshot baselines of its run ({@link collectBaselineMembers}), for the
 * snapshots of the flow and of its closure. The targets, snapshot names and
 * tool steps come from the registry's {@link collectFlowRequests}; the
 * tool-server's test/flows/flow-collect-parity.test.ts holds this walk to the
 * runner's parse. `canonical` and `spelling` describe the root flow itself.
 * Nothing is collected for arguments the tool-server refuses
 * ({@link namesValidFlow}).
 */
export async function collectFlowMembers(
  rootPath: string,
  rootBytes: Buffer,
  args: Record<string, unknown>,
  opts: PrepareFileInputsOptions
): Promise<Pick<FileInputWire, "canonical" | "spelling" | "members">> {
  if (!namesValidFlow(args)) return {};
  const canonical = await canonicalFlowPath(rootPath);
  const spelling = await classifyOnDiskSpelling(
    path.dirname(rootPath),
    path.basename(rootPath),
    FLOW_FILE_NAME_PATTERN
  );
  const roots = await closureRoots(rootPath, canonical, args.project_root);
  const members: FileInputMember[] = [];
  const seen = new Set<string>();
  const snapshots = new Set<string>();
  const budget = { inline: 0 };
  const logging = process.env[FLOW_FILES_LOG_ENV] === "1";
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const emit = (member: FileInputMember, sent: string): void => {
    members.push(member);
    const subject = member.role === "flow" ? member.canonical : member.key;
    if (logging) log(printable(`[flow-files] ${member.role} ${subject}: ${sent}`));
  };
  const queue = [{ canonical, text: rootBytes.toString("utf8"), hop: 0 }];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    let doc: unknown;
    try {
      // The runner's parse; its warnings belong to the run, not to this terminal.
      doc = parseYaml(file.text.trim(), { logLevel: "error" });
    } catch {
      continue;
    }
    const requests = collectFlowRequests(doc);
    for (const name of requests.snapshots) snapshots.add(name);
    for (const step of requests.toolSteps) {
      // A nested flow is not a file argument the runner reads for its tool.
      if (step.tool === "flow-execute") continue;
      for (const file of toolStepFiles(opts.toolFileInputs?.(step.tool), step.args)) {
        // An input whose superseding param is also set stays unread: the
        // tool's own validation refuses the call.
        const { unwrapWhenSet } = file.spec;
        if (unwrapWhenSet !== undefined && step.args[unwrapWhenSet] !== undefined) continue;
        if (!isClientFileArgument(file) || seen.has(file.path)) continue;
        seen.add(file.path);
        const read = await readToolMember(file.path, roots, budget, opts);
        emit(read.member, read.sent);
      }
    }
    const anchorDir = path.dirname(file.canonical);
    for (const target of requests.runTargets) {
      const key = flowMemberKey(anchorDir, target);
      if (seen.has(key)) continue;
      seen.add(key);
      const { member, text, sent } = await readFlowMember(anchorDir, target, roots, budget, opts);
      emit(member, sent);
      if (text !== undefined && file.hop + 1 < MAX_RUN_DEPTH) {
        queue.push({ canonical: member.canonical!, text, hop: file.hop + 1 });
      }
    }
  }
  if (snapshots.size > 0) {
    const flowName = path.basename(rootPath, ".yaml");
    await collectBaselineMembers(
      canonical,
      flowName,
      [...snapshots],
      args,
      roots,
      budget,
      opts,
      seen,
      emit
    );
  }
  return { canonical, spelling, members };
}
