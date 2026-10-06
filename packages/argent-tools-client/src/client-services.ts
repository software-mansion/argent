/**
 * Client half of client services: the handler that answers the tool-server's
 * project-file requests during a call over a link. The runner stays on the
 * server and the project stays here; each `client-request` line on the call's
 * NDJSON stream is answered through {@link ClientServicesHandler.handle}, and
 * the tools client posts the answer to `/invocations/:invocation/client-responses`.
 *
 * The handler decides what leaves and enters this machine: it reads and writes
 * nothing outside the roots the client itself sent (checked on real paths
 * before any listing, read or write), serves `.yaml` names of YAML files and
 * `.png` names of PNG files only, writes a snapshot baseline only into a
 * `__baselines__/<flow>/` directory, refuses a file above the 32 MiB cap, and
 * refuses an op it did not offer. A refusal does not say where an outside path
 * leads or whether it exists. The resolution itself is the registry's
 * `canonicalFlowPath` + `classifyOnDiskSpelling`, so a `run:` target keeps its
 * kernel meaning on the machine that has the files.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  CLIENT_CONTENT_CAP_BYTES,
  FLOW_FILE_NAME_PATTERN,
  FLOW_NAME_PATTERN,
  canonicalFlowPath,
  classifyOnDiskSpelling,
  type ClientRequestLine,
  type ClientResponseBody,
  type ClientServiceOp,
  type ClientServicesParam,
  type ReadFileAnswer,
  type ResolveFileAnswer,
  type WriteFileAnswer,
} from "@argent/registry";

import { readFileInputWire } from "./file-inputs.js";

export interface ClientServicesHandler {
  /** The `client_services` parameter to send with the call. */
  readonly param: ClientServicesParam;
  /** Never throws: a request the handler declines gets `{ ok: false, error }`. */
  handle(line: ClientRequestLine): Promise<ClientResponseBody>;
}

/** The ops this client serves, in the order they are offered. */
const IMPLEMENTED_OPS: readonly ClientServiceOp[] = ["resolve-file", "read-file", "write-file"];

const LOG_ENV = "ARGENT_CLIENT_SERVICES_LOG";

function refuse(id: string, error: string): ClientResponseBody {
  return { id, ok: false, error };
}

function logRequest(op: string, servedPath: string): void {
  if (process.env[LOG_ENV] !== "1") return;
  // The op and the path only, never the content.
  process.stderr.write(`[client-services] ${op} ${servedPath}\n`);
}

/**
 * The kernel's view of a candidate path for the root fence: the realpath of
 * its deepest existing ancestor with the missing rest re-appended. A missing
 * component cannot be a symlink, so this is where the path really points,
 * whether or not it exists. A link loop stops the kernel as it stops
 * realpath, so it is passed on for the read to name. Null for any other
 * failure: past PATH_MAX (ENAMETOOLONG) the kernel still follows a chain of
 * short relative links that realpath cannot name, so where the path leads is
 * unknown.
 */
async function resolveForFence(candidate: string): Promise<string | null> {
  const missing: string[] = [];
  let dir = candidate;
  for (;;) {
    try {
      return path.join(await fs.realpath(dir), ...missing);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") return null;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      missing.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

function isInsideRoots(resolved: string | null, roots: readonly string[]): boolean {
  if (resolved === null) return false;
  return roots.some(
    (root) =>
      resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tooLarge(file: string): string {
  return `${file} is larger than the 32 MiB cap on a file sent to the tool-server`;
}

/**
 * Read a file the fence already admitted, as the wire answer: the file when
 * it is there, `exists: false` when nothing is, or a refusal that names what
 * a host read would name (EISDIR, EACCES, the size cap).
 */
async function readAdmitted(
  file: string
): Promise<{ refusal: string } | { answer: ReadFileAnswer }> {
  const read = await readFileInputWire(file, { includeContent: true });
  if (read === null) {
    // The wire read answers null for a directory and for any stat error;
    // only a missing file is the "no such file" answer. Anything else is
    // named as a host read would name it.
    const reason = await fs.stat(file).then(
      (st) => (st.isDirectory() ? "EISDIR: illegal operation on a directory, read" : null),
      (err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? null : err.message)
    );
    return reason === null ? { answer: { exists: false } } : { refusal: reason };
  }
  if (read.contentOmitted) return { refusal: tooLarge(file) };
  if (read.content === undefined) {
    // The wire read keeps no error; read once more for the one a host read
    // would report (EACCES and the like).
    const reason = await fs.readFile(file).then(
      () => `${file} could not be read on this client`,
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );
    return { refusal: reason };
  }
  return {
    answer: { exists: true, size: read.size, mtimeMs: read.mtimeMs, content: read.content },
  };
}

/**
 * `<dir>/__baselines__/<flow>/<name>.png`, absolute and with no `..` segment:
 * the only file the tool-server reads or writes through this client, beside
 * the root flow's real file.
 */
function isBaselinePath(file: string): boolean {
  const keyDir = path.dirname(file);
  return (
    path.isAbsolute(file) &&
    !file.split(/[\\/]/).includes("..") &&
    file.endsWith(".png") &&
    path.basename(path.dirname(keyDir)) === "__baselines__" &&
    FLOW_NAME_PATTERN.test(path.basename(keyDir))
  );
}

function notBaseline(file: string, verb: "serves" | "writes"): string {
  return (
    `${file} is not a snapshot baseline (<dir>/__baselines__/<flow>/<name>.png); ` +
    `this client ${verb} baselines only`
  );
}

/**
 * Build the handler for one call, or null when there is nothing to serve:
 * no root exists on this machine, or the server advertised no op this client
 * implements. `ops` keeps the implemented order; `roots` are realpaths.
 */
export async function createClientServicesHandler(opts: {
  roots: string[];
  advertised: ClientServiceOp[];
}): Promise<ClientServicesHandler | null> {
  const resolvedRoots: string[] = [];
  for (const root of opts.roots) {
    const real = await fs.realpath(root).catch(() => null);
    if (real !== null && !resolvedRoots.includes(real)) resolvedRoots.push(real);
  }
  // A root inside another root adds no reach; keep the wire to the outermost
  // ones (the project's own `.argent/flows` is sent only when it lies elsewhere).
  const roots = resolvedRoots.filter(
    (root) => !resolvedRoots.some((other) => other !== root && isInsideRoots(root, [other]))
  );
  if (roots.length === 0) return null;
  const ops = IMPLEMENTED_OPS.filter((op) => opts.advertised.includes(op));
  if (ops.length === 0) return null;

  const param: ClientServicesParam = { ops, roots };
  const outsideRoots = `outside every root this client serves (${roots.join(", ")})`;

  async function resolveFile(
    id: string,
    args: Record<string, unknown>
  ): Promise<ClientResponseBody> {
    const { anchorDir, target, kind } = args;
    if (typeof anchorDir !== "string" || typeof target !== "string" || typeof kind !== "string") {
      return refuse(id, "resolve-file needs string anchorDir, target and kind");
    }
    if (kind !== "flow") {
      return refuse(id, `kind "${kind}" is not known to this client; it serves "flow" only`);
    }
    const base = path.posix.basename(target);
    if (!base.endsWith(".yaml")) {
      return refuse(id, `${target} is not a .yaml file; this client serves flow files only`);
    }
    if (!isInsideRoots(await resolveForFence(anchorDir), roots)) {
      return refuse(id, `anchor directory ${anchorDir} is ${outsideRoots}`);
    }

    // Same join and same classifier as the tool-server's own resolution, so
    // `..` and casing mean here what they mean in a co-located run. Both
    // places the resolution reads are fenced before anything there is read:
    // the file the target really points to, and the directory the casing
    // check lists. The refusal is the same whether or not the path exists.
    const spelled = anchorDir + path.sep + target;
    const canonical = await canonicalFlowPath(spelled);
    const [resolved, listedDir] = await Promise.all([
      resolveForFence(canonical),
      resolveForFence(path.dirname(spelled)),
    ]);
    if (!isInsideRoots(resolved, roots) || !isInsideRoots(listedDir, roots)) {
      return refuse(id, `${target} is ${outsideRoots}`);
    }
    // A `.yaml` name that links to a file that is not YAML (a `.env`) would
    // send that file; a link to a `.yml` flow is an ordinary layout.
    if (!/\.ya?ml$/i.test(path.basename(resolved!))) {
      return refuse(id, `${target} links to a file that is not a YAML file`);
    }
    const spelling = await classifyOnDiskSpelling(
      path.dirname(spelled),
      base,
      FLOW_FILE_NAME_PATTERN
    );
    logRequest("resolve-file", canonical);

    const read = await readAdmitted(canonical);
    if ("refusal" in read) return refuse(id, read.refusal);
    const answer: ResolveFileAnswer = { canonical, spelling, ...read.answer };
    return { id, ok: true, ...answer };
  }

  // A snapshot baseline, read as the server names it: the server built the
  // path beside the root flow's real file, so there is nothing to resolve.
  async function readFile(id: string, args: Record<string, unknown>): Promise<ClientResponseBody> {
    const file = args.path;
    if (typeof file !== "string") return refuse(id, "read-file needs a string path");
    if (!isBaselinePath(file)) return refuse(id, notBaseline(file, "serves"));
    const resolved = await resolveForFence(file);
    if (!isInsideRoots(resolved, roots)) return refuse(id, `${file} is ${outsideRoots}`);
    // A `.png` name that links to another kind of file (a `.env`) would send it.
    if (!resolved!.endsWith(".png")) {
      return refuse(id, `${file} links to a file that is not a PNG file`);
    }
    logRequest("read-file", file);
    const read = await readAdmitted(file);
    if ("refusal" in read) return refuse(id, read.refusal);
    return { id, ok: true, ...read.answer };
  }

  // A new snapshot baseline. The only file the tool-server may write here, and
  // only into a `__baselines__/<flow>/` directory under a root: the place a
  // run with no link writes it, beside the root flow's real file.
  async function writeFile(id: string, args: Record<string, unknown>): Promise<ClientResponseBody> {
    const { path: file, content } = args;
    if (typeof file !== "string" || typeof content !== "string") {
      return refuse(id, "write-file needs string path and content");
    }
    if (!isBaselinePath(file)) return refuse(id, notBaseline(file, "writes"));
    const keyDir = path.dirname(file);
    // Fenced before the directory is created, so a symlinked `__baselines__`
    // that leads out of the roots gets no directory made there either.
    if (!isInsideRoots(await resolveForFence(keyDir), roots)) {
      return refuse(id, `${file} is ${outsideRoots}`);
    }
    const bytes = Buffer.from(content, "base64");
    if (bytes.length > CLIENT_CONTENT_CAP_BYTES) {
      return refuse(id, `${file}: the baseline is larger than the 32 MiB cap on a file it writes`);
    }
    await fs.mkdir(keyDir, { recursive: true });
    // Again on the file itself: a baseline that is a symlink writes through.
    // A dangling one would create its target, wherever it points, and the
    // fence cannot see where that is, so it is refused outright.
    const isLink = await fs.lstat(file).then(
      (st) => st.isSymbolicLink(),
      () => false
    );
    if (isLink && (await fs.realpath(file).catch(() => null)) === null) {
      return refuse(id, `${file} is a symbolic link to a missing file`);
    }
    const resolved = await resolveForFence(file);
    if (!isInsideRoots(resolved, roots)) return refuse(id, `${file} is ${outsideRoots}`);
    if (!resolved!.endsWith(".png")) {
      return refuse(id, `${file} links to a file that is not a PNG file`);
    }
    const replaced = await fs.stat(file).then(
      () => true,
      () => false
    );
    logRequest("write-file", file);
    await fs.writeFile(file, bytes);
    const answer: WriteFileAnswer = { written: file, replaced };
    return { id, ok: true, ...answer };
  }

  async function handle(line: ClientRequestLine): Promise<ClientResponseBody> {
    // A broken server may send any JSON here; none of it may make this throw.
    const id = typeof line.id === "string" ? line.id : "";
    const op = typeof line.op === "string" ? line.op : "(not a string)";
    try {
      if (!ops.includes(line.op)) return refuse(id, `op ${op} is not served by this client`);
      if (!isRecord(line.args)) return refuse(id, `${op} request carries no args object`);
      if (line.op === "read-file") return await readFile(id, line.args);
      if (line.op === "write-file") return await writeFile(id, line.args);
      return await resolveFile(id, line.args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return refuse(id, `${op} failed on this client: ${message}`);
    }
  }

  return { param, handle };
}
