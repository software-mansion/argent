/**
 * The flow half of the INPUT-side file boundary: the files a `collect: "flow"`
 * file input sends with the flow over a link (see `file-inputs.ts` for the
 * generic wire, upload and directive code). {@link collectFlowMembers} walks
 * the flow's `run:` closure on THIS machine and returns it as the wire's
 * `members`, each one inline, uploaded, or with the state that tells the
 * tool-server why it was not sent.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import {
  FLOW_FILE_NAME_PATTERN,
  FLOW_NAME_PATTERN,
  MAX_RUN_DEPTH,
  canonicalFlowPath,
  classifyOnDiskSpelling,
  collectFlowRequests,
  flowMemberKey,
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
