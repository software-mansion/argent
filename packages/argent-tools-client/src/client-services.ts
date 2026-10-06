/**
 * Client half of client services: the handler that answers the tool-server's
 * project-file requests during a call over a link. The runner stays on the
 * server and the project stays here; each `client-request` line on the call's
 * NDJSON stream is answered through {@link ClientServicesHandler.handle}, and
 * the tools client posts the answer to `/invocations/:invocation/client-responses`.
 *
 * The handler enforces every rule of the channel; the server enforces none:
 * it serves a path only when its realpath lies inside one of the roots the
 * client itself sent, serves `.yaml` files only, refuses a
 * file above the 32 MiB cap, and refuses an op it did not offer. The resolution
 * itself is the registry's `canonicalFlowPath` + `classifyOnDiskSpelling`, so a
 * `run:` target keeps its kernel meaning on the machine that has the files.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  FLOW_FILE_NAME_PATTERN,
  canonicalFlowPath,
  classifyOnDiskSpelling,
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

function refuse(id: string, error: string): ClientResponseBody {
  return { id, ok: false, error };
}

function logRequest(op: string, servedPath: string): void {
  if (process.env[LOG_ENV] !== "1") return;
  // The op and the path only, never the content.
  process.stderr.write(`[client-services] ${op} ${servedPath}\n`);
}

/**
 * The kernel's view of a candidate path for the root fence: its realpath, or
 * for one that does not exist yet, its parent's realpath with the basename
 * re-appended. Null when the parent does not resolve either; such a candidate
 * is not inside any root.
 */
async function resolveForFence(candidate: string): Promise<string | null> {
  try {
    return await fs.realpath(candidate);
  } catch {
    try {
      return path.join(await fs.realpath(path.dirname(candidate)), path.basename(candidate));
    } catch {
      return null;
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
    // `..` and casing mean here what they mean in a co-located run.
    const spelled = anchorDir + path.sep + target;
    const canonical = await canonicalFlowPath(spelled);
    const spelling = await classifyOnDiskSpelling(
      path.dirname(spelled),
      base,
      FLOW_FILE_NAME_PATTERN
    );
    const resolved = await resolveForFence(canonical);
    if (resolved === null) {
      return refuse(
        id,
        `${target} cannot be resolved under ${anchorDir} on this client: its directory does not exist`
      );
    }
    if (!isInsideRoots(resolved, roots)) {
      return refuse(id, `${target} resolves to ${resolved}, ${outsideRoots}`);
    }
    logRequest("resolve-file", canonical);

    const read = await readFileInputWire(canonical, { includeContent: true });
    if (read === null) {
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
      return refuse(id, `${canonical} exists but could not be read on this client`);
    }
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

  async function handle(line: ClientRequestLine): Promise<ClientResponseBody> {
    const id = typeof line.id === "string" ? line.id : String(line.id);
    const op = String(line.op);
    try {
      if (!ops.includes(line.op)) return refuse(id, `op ${op} is not served by this client`);
      if (!isRecord(line.args)) return refuse(id, `${op} request carries no args object`);
      return await resolveFile(id, line.args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return refuse(id, `${op} failed on this client: ${message}`);
    }
  }

  return { param, handle };
}
