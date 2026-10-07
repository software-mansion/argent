/**
 * Client half of client services: the handler that answers the tool-server's
 * project-file requests during a call over a link. The runner stays on the
 * server and the project stays here; each `client-request` line on the call's
 * NDJSON stream is answered through {@link ClientServicesHandler.handle}, and
 * the tools client posts the answer to `/invocations/:invocation/client-responses`.
 *
 * The handler decides what leaves this machine. It serves the files the
 * user's own flows compose and nothing else: the call's root flow, and each
 * `run:` target named by a file it has already served, resolved beside that
 * file as the runner resolves it. A request for any other file is refused
 * before it is read, the same way whether or not the file exists. It reads
 * nothing outside the roots the client itself sent, serves `.yaml` names of
 * YAML files only, refuses a file above the 32 MiB cap, and refuses an op it
 * did not offer. A requested path is resolved here as the kernel resolves it,
 * one component at a time ({@link walk}), and each place the walk would look
 * at is checked against the roots before anything there is looked at, so an
 * outside path gets one refusal whatever exists there. The casing verdict is
 * the registry's `classifyOnDiskSpelling`, so a `run:` target keeps its kernel
 * meaning on the machine that has the files.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import {
  FLOW_FILE_NAME_PATTERN,
  classifyOnDiskSpelling,
  completeRunExtension,
  type ClientRequestLine,
  type ClientResponseBody,
  type ClientServiceOp,
  type ClientServicesParam,
  type ResolveFileAnswer,
} from "@argent/registry";

import { readFileInputWire } from "./file-inputs.js";

export interface ClientServicesHandler {
  /** The `client_services` parameter to send with the call. */
  readonly param: ClientServicesParam;
  /** Never throws: a request the handler declines gets `{ ok: false, error }`. */
  handle(line: ClientRequestLine): Promise<ClientResponseBody>;
}

/** The ops this client serves, in the order they are offered. */
const IMPLEMENTED_OPS: readonly ClientServiceOp[] = ["resolve-file"];

const LOG_ENV = "ARGENT_CLIENT_SERVICES_LOG";

/** Linux's MAXSYMLINKS: the walk reports ELOOP past this many links. */
const MAX_SYMLINKS = 40;

/** Deeper than any block nesting the runner parses; ends a cyclic alias too. */
const MAX_STEP_DEPTH = 64;

function refuse(id: string, error: string): ClientResponseBody {
  return { id, ok: false, error };
}

/** Escapes control characters, so a target the server chose cannot forge a log line. */
function printable(text: string): string {
  return [...text]
    .map((c) =>
      c < " " || c === "\x7f" ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c
    )
    .join("");
}

/** `inner` is `outer` or lies under it; both absolute and normalized. */
function isWithin(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
}

function isInsideRoots(position: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(position, root));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where the walk may look. `roots` are real paths. `spelled` are the roots as
 * the client wrote them: the root flow's own directory is one, and the server
 * anchors its first request there, so the walk crosses whatever symlink lies
 * above the real root on that spelling (`/tmp`, `/var` on macOS).
 */
interface Fence {
  roots: readonly string[];
  spelled: readonly string[];
}

/** Inside a root, or on the way to one: the only places the walk looks at. */
function mayVisit(fence: Fence, position: string): boolean {
  return (
    fence.roots.some((root) => isWithin(position, root) || isWithin(root, position)) ||
    fence.spelled.some((root) => isWithin(root, position))
  );
}

/**
 * The `run:` targets a flow file names, spelled as the runner requests them:
 * every string `run` in its `steps`, and in the `steps` of a block directive
 * (`when`), with the runner's extension completion. A value the runner
 * refuses (a backslash, an absolute or drive-prefixed path) names nothing, and
 * so does a file that does not parse.
 */
function runTargets(content: string): string[] {
  let doc: unknown;
  try {
    // The runner's parse; its warnings belong to the run, not to this terminal.
    doc = parseYaml(content.trim(), { logLevel: "error" });
  } catch {
    return [];
  }
  const targets: string[] = [];
  const seen = new Set<unknown>();
  const visit = (steps: unknown, depth: number): void => {
    if (!Array.isArray(steps) || depth > MAX_STEP_DEPTH || seen.has(steps)) return;
    seen.add(steps);
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const run = step.run;
      if (
        typeof run === "string" &&
        !run.includes("\\") &&
        !path.posix.isAbsolute(run) &&
        !/^[A-Za-z]:/.test(run)
      ) {
        targets.push(completeRunExtension(run));
      }
      visit(step.steps, depth + 1);
    }
  };
  if (isRecord(doc)) visit(doc.steps, 0);
  return targets;
}

function components(p: string): string[] {
  const rest = p.slice(path.parse(p).root.length);
  return rest.split(path.sep === "\\" ? /[\\/]/ : "/").filter((c) => c !== "" && c !== ".");
}

/**
 * What a spelled path resolves to. `found`: an existing entry, at its real
 * path. `missing`: a component does not exist; `canonical` continues the
 * spelling lexically from there. `failed`: the kernel would report `error`
 * (a link loop, a file used as a directory, an lstat error); `canonical`
 * continues the same way. `outside`: the walk would have looked outside the
 * roots, or ends there.
 */
type Walked =
  | { kind: "outside" }
  | { kind: "found" | "missing"; canonical: string }
  | { kind: "failed"; canonical: string; error: string };

/**
 * A symlink the user made may spell its target through an alias that lies
 * above the roots, as `/tmp` and `/var` do on macOS, and {@link mayVisit} does
 * not admit the alias itself. Such a position is followed when it is a
 * symlink that resolves inside a root or on the way to one. Only a name taken
 * from a link's target is judged this way, never one the server spelled, so
 * all a server can learn is that a link of the user's leads back toward the
 * roots.
 */
async function isAliasIntoFence(fence: Fence, position: string): Promise<boolean> {
  const st = await fs.lstat(position).catch(() => null);
  if (!st?.isSymbolicLink()) return false;
  const real = await fs.realpath(position).catch(() => null);
  return real !== null && mayVisit(fence, real);
}

/**
 * Resolve an absolute spelled path as the kernel does, `..` included: a name
 * is looked up in the current real directory, a symlink's target is spliced
 * in (an absolute one restarts at the filesystem root), and `..` is the parent
 * of the current REAL position. Every position is checked with
 * {@link mayVisit} before the disk is touched there, so whatever lies outside
 * the roots is never looked at: the walk refuses before it would, and the same
 * way whether that place exists or not ({@link isAliasIntoFence} is the one
 * exception, for the user's own links). A realpath at each directory folds a
 * case-insensitive spelling to the on-disk one, so for an existing file the
 * result is what `fs.realpath` returns. Once a component cannot be resolved
 * the walk goes on lexically and touches nothing more.
 */
async function walk(spelled: string, fence: Fence): Promise<Walked> {
  const pending = components(spelled).map((name) => ({ name, linked: false }));
  let position = path.parse(spelled).root;
  let links = 0;
  let stopped: { kind: "missing" } | { kind: "failed"; error: string } | null = null;
  while (pending.length > 0) {
    const { name, linked } = pending.shift()!;
    const next = name === ".." ? path.dirname(position) : path.join(position, name);
    if (
      !mayVisit(fence, next) &&
      !(linked && name !== ".." && stopped === null && (await isAliasIntoFence(fence, next)))
    ) {
      return { kind: "outside" };
    }
    if (name === ".." || stopped !== null) {
      position = next;
      continue;
    }
    try {
      const st = await fs.lstat(next);
      if (st.isSymbolicLink()) {
        if (++links > MAX_SYMLINKS) {
          stopped = {
            kind: "failed",
            error: `ELOOP: too many symbolic links encountered, open '${spelled}'`,
          };
          position = next;
          continue;
        }
        const target = await fs.readlink(next);
        if (path.isAbsolute(target)) position = path.parse(target).root;
        pending.unshift(...components(target).map((name) => ({ name, linked: true })));
        continue;
      }
      position = await fs.realpath(next);
      if (!st.isDirectory() && pending.length > 0) {
        stopped = { kind: "failed", error: `ENOTDIR: not a directory, open '${spelled}'` };
      }
    } catch (err) {
      stopped =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? { kind: "missing" }
          : { kind: "failed", error: err instanceof Error ? err.message : String(err) };
      position = next;
    }
  }
  if (!isInsideRoots(position, fence.roots)) return { kind: "outside" };
  return stopped === null
    ? { kind: "found", canonical: position }
    : { ...stopped, canonical: position };
}

/**
 * Build the handler for one call, or null when there is nothing to serve:
 * no root exists on this machine, the server advertised no op this client
 * implements, or the root flow names no `run:` target (or cannot be read or
 * parsed here). The runner asks for files only to resolve `run:` targets, so
 * a flow that composes nothing goes out without client services, as it did
 * before they existed, and keeps running through a proxy that rewrites
 * `Accept`. `ops` keeps the implemented order; `roots` are realpaths.
 * `rootFlow` is the call's root flow file as the client sent it; the server
 * asks for it in the directory it is spelled in.
 *
 * Under `ARGENT_CLIENT_SERVICES_LOG=1` each request gets one line once its
 * answer is decided, `[client-services] <op> <path>: served`, `: missing` or
 * `: refused (<the error sent>)`, written to `log` (stderr by default). The
 * path is the canonical one once the request is known to be a file this call
 * serves, and the target as received before that, so a refused probe is
 * logged as the server spelled it. Never the content.
 */
export async function createClientServicesHandler(opts: {
  roots: string[];
  rootFlow: string;
  advertised: ClientServiceOp[];
  log?: (line: string) => void;
}): Promise<ClientServicesHandler | null> {
  const resolvedRoots: string[] = [];
  const spelledRoots: string[] = [];
  for (const root of opts.roots) {
    const real = await fs.realpath(root).catch(() => null);
    if (real === null) continue;
    if (!resolvedRoots.includes(real)) resolvedRoots.push(real);
    spelledRoots.push(path.resolve(root));
  }
  // A root inside another root adds no reach; keep the wire to the outermost
  // ones (the project's own `.argent/flows` is sent only when it lies elsewhere).
  const roots = resolvedRoots.filter(
    (root) => !resolvedRoots.some((other) => other !== root && isWithin(root, other))
  );
  if (roots.length === 0) return null;
  const ops = IMPLEMENTED_OPS.filter((op) => opts.advertised.includes(op));
  if (ops.length === 0) return null;

  const param: ClientServicesParam = { ops, roots };
  const fence: Fence = { roots, spelled: spelledRoots };
  const outsideRoots = (target: string) =>
    `${target} is outside every root this client serves (${roots.join(", ")})`;

  // The real paths this call may serve: the root flow, and the run: targets
  // of each file served, resolved beside that file as the runner anchors them.
  const servable = new Set<string>();
  async function addRunTargets(canonical: string, targets: string[]): Promise<void> {
    for (const target of targets) {
      const walked = await walk(path.dirname(canonical) + path.sep + target, fence);
      if (walked.kind !== "outside") servable.add(walked.canonical);
    }
  }
  const root = await walk(opts.rootFlow, fence);
  if (root.kind !== "found") return null;
  const rootText = await fs.readFile(root.canonical, "utf8").catch(() => null);
  const rootTargets = rootText === null ? [] : runTargets(rootText);
  if (rootTargets.length === 0) return null;
  servable.add(root.canonical);
  await addRunTargets(root.canonical, rootTargets);

  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));

  /** `named.path` is set to the canonical path once the request is one this call serves. */
  async function resolveFile(
    id: string,
    args: Record<string, unknown>,
    named: { path?: string }
  ): Promise<ClientResponseBody> {
    const { anchorDir, target, kind } = args;
    if (typeof anchorDir !== "string" || typeof target !== "string" || typeof kind !== "string") {
      return refuse(id, "resolve-file needs string anchorDir, target and kind");
    }
    if (kind !== "flow") {
      return refuse(id, `kind "${kind}" is not known to this client; it serves "flow" only`);
    }
    if (!path.isAbsolute(anchorDir)) {
      return refuse(id, "resolve-file needs an absolute anchorDir");
    }
    const base = path.posix.basename(target);
    if (!base.endsWith(".yaml")) {
      return refuse(id, `${target} is not a .yaml file; this client serves flow files only`);
    }

    // Same join as the tool-server's own resolution, so `..` and casing mean
    // here what they mean in a co-located run. Both places the resolution
    // reads are walked under the fence before anything there is read: the
    // file the target points to, and the directory the casing check lists.
    const spelled = anchorDir + path.sep + target;
    const file = await walk(spelled, fence);
    if (file.kind === "outside") return refuse(id, outsideRoots(target));
    if (!servable.has(file.canonical)) {
      return refuse(id, `${target} is not a run: target of a flow this client served`);
    }
    named.path = file.canonical;
    if ((await walk(path.dirname(spelled), fence)).kind === "outside") {
      return refuse(id, outsideRoots(target));
    }
    if (file.kind === "failed") return refuse(id, file.error);
    const canonical = file.canonical;
    const spelling = await classifyOnDiskSpelling(
      path.dirname(spelled),
      base,
      FLOW_FILE_NAME_PATTERN
    );
    if (file.kind === "missing") {
      const answer: ResolveFileAnswer = { canonical, spelling, exists: false };
      return { id, ok: true, ...answer };
    }
    // A `.yaml` name that links to a file that is not YAML (a `.env`) would
    // send that file; a link to a `.yml` flow is an ordinary layout.
    if (!/\.ya?ml$/i.test(path.basename(canonical))) {
      return refuse(id, `${target} links to a file that is not a YAML file`);
    }

    const read = await readFileInputWire(canonical, { includeContent: true });
    if (read === null) {
      // The wire read answers null for a directory and for any stat error;
      // only a missing file is the "no such fragment" answer. Anything else is
      // named as a host read would name it.
      const reason = await fs.stat(canonical).then(
        (st) => (st.isDirectory() ? "EISDIR: illegal operation on a directory, read" : null),
        (err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? null : err.message)
      );
      if (reason !== null) return refuse(id, reason);
      const answer: ResolveFileAnswer = { canonical, spelling, exists: false };
      return { id, ok: true, ...answer };
    }
    if (read.contentOmitted) {
      return refuse(
        id,
        `${canonical} is larger than the 32 MiB cap on a file sent to the tool-server`
      );
    }
    if (read.content === undefined) {
      // The wire read keeps no error; read once more for the one a host read
      // would report (EACCES and the like).
      const reason = await fs.readFile(canonical).then(
        () => `${canonical} could not be read on this client`,
        (err: unknown) => (err instanceof Error ? err.message : String(err))
      );
      return refuse(id, reason);
    }
    await addRunTargets(
      canonical,
      runTargets(Buffer.from(read.content, "base64").toString("utf8"))
    );
    const answer: ResolveFileAnswer = {
      canonical,
      spelling,
      exists: true,
      size: read.size,
      mtimeMs: read.mtimeMs,
      content: read.content,
    };
    return { id, ok: true, ...answer };
  }

  async function decide(
    line: ClientRequestLine,
    named: { path?: string }
  ): Promise<ClientResponseBody> {
    // A broken server may send any JSON here; none of it may make this throw.
    const id = typeof line.id === "string" ? line.id : "";
    const op = typeof line.op === "string" ? line.op : "(not a string)";
    try {
      if (!ops.includes(line.op)) return refuse(id, `op ${op} is not served by this client`);
      if (!isRecord(line.args)) return refuse(id, `${op} request carries no args object`);
      return await resolveFile(id, line.args, named);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return refuse(id, `${op} failed on this client: ${message}`);
    }
  }

  async function handle(line: ClientRequestLine): Promise<ClientResponseBody> {
    const named: { path?: string } = {};
    const body = await decide(line, named);
    if (process.env[LOG_ENV] === "1") {
      const op = typeof line.op === "string" ? line.op : "(not a string)";
      const target = isRecord(line.args) ? line.args.target : undefined;
      const subject = named.path ?? (typeof target === "string" ? target : "(no target)");
      const outcome = !body.ok ? `refused (${body.error})` : body.exists ? "served" : "missing";
      try {
        log(printable(`[client-services] ${op} ${subject}: ${outcome}`));
      } catch {
        // A failing log sink must not cost the server its answer.
      }
    }
    return body;
  }

  return { param, handle };
}
