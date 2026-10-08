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

/**
 * Every op name the protocol reserves. `resolve-file`, `read-file` and
 * `write-file` are served; `run-script` is reserved and served by no client.
 */
export const CLIENT_SERVICE_OPS = [
  "resolve-file",
  "read-file",
  "write-file",
  "run-script",
] as const;
export type ClientServiceOp = (typeof CLIENT_SERVICE_OPS)[number];

/** What a tool's `GET /tools` entry carries when the tool can use the channel. */
export interface ClientServicesAdvert {
  ops: ClientServiceOp[];
}

/** The `client_services` parameter the client adds to a call it serves. */
export interface ClientServicesParam {
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

export interface ReadFileArgs {
  /** Absolute client path of the file. */
  path: string;
}

/** {@link ResolveFileAnswer} without the resolution: the path is read as given. */
export interface ReadFileAnswer {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  /** The file as base64, when `exists`. */
  content?: string;
}

export interface WriteFileArgs {
  /** Absolute client path, of the form `<dir>/__baselines__/<key>/<file>.png`. */
  path: string;
  /** The file as base64. */
  content: string;
}

export interface WriteFileAnswer {
  /** The path the client wrote. */
  written: string;
  /** Whether a file was at the path before the write. */
  replaced: boolean;
}

/**
 * The names a file argument of a `tool:` step may have to travel over a link,
 * in any case of letters: the files the tools take (`screenshot-diff` PNGs, a
 * `flow_path`). The tool-server refuses another one before the first step,
 * and the client serves no other one.
 */
export const TOOL_FILE_EXTENSIONS = [".png", ".yaml"] as const;

export function hasToolFileExtension(file: string): boolean {
  const name = file.toLowerCase();
  return TOOL_FILE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * The request header the argent tools client sets to `1` on every call it
 * sends over `argent link` or `ARGENT_TOOLS_URL`, a link to 127.0.0.1
 * included. The tool-server reads it as `InvokeToolOptions.linked`.
 */
export const LINKED_CALL_HEADER = "x-argent-linked";

/** How long the server waits for the answer to a file op. */
export const CLIENT_FILE_OP_TIMEOUT_MS = 30_000;
/** The decoded size cap of a file carried in an answer or a write; mirrors the file-input cap. */
export const CLIENT_CONTENT_CAP_BYTES = 32 * 1024 * 1024;

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** Validates the `client_services` parameter on the wire. */
export const clientServicesParamSchema = z.object({
  ops: z.array(z.enum(CLIENT_SERVICE_OPS)),
  roots: z.array(
    z.string().refine((root) => ABSOLUTE_PATH.test(root), {
      message: "each root must be an absolute path",
    })
  ),
});
