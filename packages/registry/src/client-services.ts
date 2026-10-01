/**
 * Client services: the channel through which the tool-server asks the CLIENT
 * for project files during a tool call. The runner stays on the server and the
 * project stays on the client; every project read the runner needs over a link
 * becomes one request on the call's NDJSON stream, answered by the client on a
 * separate HTTP request (`POST /invocations/:invocation/client-responses`).
 *
 * Capability-gated, never version-gated: a tool that can use the channel
 * advertises it through `GET /tools` ({@link ClientServicesAdvert}); the client
 * opts in per call with the `client_services` parameter
 * ({@link ClientServicesParam}), listing the ops it serves and the roots it
 * serves them under. The server uses an op only when the client listed it, and
 * the client serves a path only under the roots it sent itself.
 */

import { z } from "zod";
import type { OnDiskSpelling } from "./flow-file-refs";

export const CLIENT_SERVICES_VERSION = 1 as const;

/**
 * Every op name the protocol reserves. Only `resolve-file` and `list-dir` are
 * served today; the others are defined so the schema accepts them once a later
 * version adds their handlers.
 */
export const CLIENT_SERVICE_OPS = [
  "resolve-file",
  "read-file",
  "write-file",
  "run-script",
  "list-dir",
] as const;
export type ClientServiceOp = (typeof CLIENT_SERVICE_OPS)[number];

/** What a tool's `GET /tools` entry carries when the tool can use the channel. */
export interface ClientServicesAdvert {
  version: typeof CLIENT_SERVICES_VERSION;
  ops: ClientServiceOp[];
}

/** The `client_services` parameter the client adds to a call it serves. */
export interface ClientServicesParam {
  version: typeof CLIENT_SERVICES_VERSION;
  ops: ClientServiceOp[];
  /** Absolute client directories the handler serves files under. */
  roots: string[];
}

export const CLIENT_REQUEST_EVENT = "client-request" as const;

/** One request line on the NDJSON stream of the call. */
export interface ClientRequestLine {
  event: typeof CLIENT_REQUEST_EVENT;
  /** The `toolInvocationId` of the call; names the answer endpoint. */
  invocation: string;
  id: string;
  op: ClientServiceOp;
  args: Record<string, unknown>;
}

/** The body the client posts to `/invocations/:invocation/client-responses`. */
export type ClientResponseBody =
  | { id: string; ok: true; [key: string]: unknown }
  | { id: string; ok: false; error: string };

export interface ResolveFileArgs {
  /** Absolute client path of the directory of the file that contains the step. */
  anchorDir: string;
  /** The `run:` target as written, e.g. `frag.yaml` or `../shared/login.yaml`. */
  target: string;
  kind: "flow" | "script";
}

export interface ResolveFileAnswer {
  /** `canonicalFlowPath(anchorDir + sep + target)` computed on the client. */
  canonical: string;
  spelling: OnDiskSpelling;
  /** True when the client could stat `canonical` as a file. */
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  /** The file as base64, when `exists` and the kind is read whole (`flow`). */
  content?: string;
}

export interface ListDirArgs {
  /** Absolute client path of a directory. */
  path: string;
}

export interface ListDirAnswer {
  /** `fs.readdir(path)` on the client, or null when readdir failed. */
  entries: string[] | null;
}

/** How long the server waits for the answer to a file op. */
export const CLIENT_FILE_OP_TIMEOUT_MS = 30_000;
/** The decoded size cap of a file carried in an answer; mirrors the file-input cap. */
export const CLIENT_CONTENT_CAP_BYTES = 32 * 1024 * 1024;

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** Validates the `client_services` parameter on the wire. */
export const clientServicesParamSchema = z.object({
  version: z.literal(CLIENT_SERVICES_VERSION),
  ops: z.array(z.enum(CLIENT_SERVICE_OPS)),
  roots: z.array(
    z.string().refine((root) => ABSOLUTE_PATH.test(root), {
      message: "each root must be an absolute path",
    })
  ),
});
