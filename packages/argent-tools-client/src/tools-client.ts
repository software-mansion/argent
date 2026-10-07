import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";

import {
  CLIENT_FILE_OP_TIMEOUT_MS,
  CLIENT_REQUEST_EVENT,
  FAILURE_CODES,
  FLOW_FILE_NAME_PATTERN,
  FLOW_NAME_PATTERN,
  describeParamIssues,
  type ClientRequestLine,
  type ClientResponseBody,
  type ClientServicesAdvert,
} from "@argent/registry";

import { ensureToolsServer, type ToolsServerHandle, type ToolsServerPaths } from "./launcher.js";
import { getResolvedToolsUrl } from "./link-config.js";
import {
  prepareFileInputs,
  applyClientFileDirectives,
  FILE_INPUT_MARKER,
  type FileInputSpec,
  type FileInputWire,
} from "./file-inputs.js";
import { createClientServicesHandler, type ClientServicesHandler } from "./client-services.js";

export interface ToolMeta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputHint?: string;
  /** Args that name files on the CALLER's machine — see file-inputs.ts. */
  fileInputs?: FileInputSpec[];
  /** Set when the tool can ask the caller for project files — see client-services.ts. */
  clientServices?: ClientServicesAdvert;
  alwaysLoad?: boolean;
  searchHint?: string;
  longRunning?: boolean;
}

export interface ToolInvocationResult {
  data: unknown;
  note?: string;
  /** The `outputHint` of the tool's listing entry, when it has one. */
  outputHint?: string;
}

export interface CallToolOptions {
  /**
   * Receive live progress events while the tool runs, by asking the server for
   * an NDJSON stream. A server that answers with plain JSON fires no events.
   */
  onProgress?: (event: unknown) => void;
}

export interface ToolsClient {
  fetchTools(): Promise<ToolMeta[]>;
  fetchTool(name: string): Promise<ToolMeta | null>;
  callTool(name: string, args: unknown, opts?: CallToolOptions): Promise<ToolInvocationResult>;
  /** Returns the tool-server base URL + auth token, spawning if needed. */
  baseUrl(): Promise<ToolsServerHandle>;
}

export interface CreateToolsClientOptions {
  /** Locations of bundled artifacts. Required unless a tool-server URL is configured. */
  paths?: ToolsServerPaths;
  /**
   * Override the resolution of the tool-server: its URL and token, and
   * `remote`, which says whether file inputs travel with a call (inlined
   * content and uploads). The MCP adapter freezes routing at startup and
   * updates the handle after a local respawn. When set, the client never reads
   * the link config and never spawns.
   */
  baseUrl?: () => Promise<ToolsServerHandle & { remote: boolean }>;
  /**
   * Override the fetch used for GET /tools and POST /tools/:name, so a caller
   * can wrap retries and a per-attempt timeout around each request.
   * `meta.longRunning` is the tool's flag from the listing (false for GET
   * /tools), so the caller can disable its timeout. `meta.carriesUpload` is true
   * when the body names an upload: the tool-server consumes an upload on the
   * first request that reaches it, so the caller must not abort or resend that
   * request. POST /upload and the client-services answer POSTs keep the global
   * fetch.
   */
  fetchImpl?: (
    url: string,
    init: RequestInit,
    meta: { longRunning: boolean; carriesUpload: boolean }
  ) => Promise<Response>;
  /**
   * Receives each diagnostic line of client services (a request line it had to
   * drop, a request it gave up, an answer the tool-server did not take, and
   * the request log that `ARGENT_CLIENT_SERVICES_LOG=1` turns on), without a
   * trailing newline.
   * Defaults to writing the line to stderr; `argent flow run --json` turns it
   * into a JSON record, since its stderr carries one JSON object per line.
   */
  onDiagnostic?: (message: string) => void;
}

/**
 * A tool invocation the SERVER answered with an error — an HTTP error status or
 * the NDJSON stream's terminal `error` line. `errorKind`/`errorCode` carry the
 * server's failure signal (e.g. kind "validation") when it sent one.
 *
 * `issues` is the issue list a 400 carries beside its prose message, so a caller
 * can map a rejected field back to the flag its user typed. Undefined for an
 * older server.
 */
export class ToolInvocationError extends Error {
  readonly errorCode?: string;
  readonly errorKind?: string;
  readonly issues?: readonly unknown[];
  constructor(
    message: string,
    signal?: { errorCode?: string; errorKind?: string; issues?: readonly unknown[] }
  ) {
    super(message);
    this.name = "ToolInvocationError";
    this.errorCode = signal?.errorCode;
    this.errorKind = signal?.errorKind;
    this.issues = signal?.issues;
  }
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * How a stream's `client-request` lines are answered: the handler, where to
 * post, and where a diagnostic goes.
 */
interface ClientServicesLink {
  handler: ClientServicesHandler;
  answerUrl: (invocation: string) => string;
  headers: Record<string, string>;
  diagnose: (message: string) => void;
}

/**
 * A request line as the tool-server's own messages name it: its op and its
 * target, or the path of a baseline.
 */
function describeRequest(msg: ClientRequestLine): string {
  const { op, args } = msg as { op?: unknown; args?: unknown };
  const named = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const target = named.target ?? named.path;
  return (
    `the ${typeof op === "string" ? op : "unknown"} request` +
    (typeof target === "string" ? ` for "${target}"` : "")
  );
}

/**
 * The handler's answer, or undefined once the tool-server has stopped waiting
 * for it: a local read can hang (a file on an unresponsive network mount), and
 * an answer after that settles nothing.
 */
async function answerInTime(
  link: ClientServicesLink,
  msg: ClientRequestLine
): Promise<ClientResponseBody | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), CLIENT_FILE_OP_TIMEOUT_MS);
    // The timer alone must not keep the process up after the call ended.
    timer.unref();
  });
  try {
    return await Promise.race([link.handler.handle(msg), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error's message, with its cause's: fetch says only "fetch failed" itself. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}

/**
 * The `error` of the tool-server's own refusal of an answer, or undefined when
 * the reply is not one. Its answer route sends, each with a JSON `error`: 400
 * for a malformed answer, 404 for one after its timeout or after the call
 * ended, 409 for a second one, 413 for one above the size cap (which it turns
 * into a refusal of the request). The route was reached and the request is
 * settled there, so the run goes on and its report says what became of it.
 */
function answerRouteRefusal(status: number, text: string): string | undefined {
  if (![400, 404, 409, 413].includes(status)) return undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** The failure of a call whose answer to `request` did not reach the tool-server. */
function undeliveredAnswer(request: string, url: string, reason: string): ToolInvocationError {
  return new ToolInvocationError(
    `The answer to ${request} did not reach the tool-server: POST ${url} ${reason}. The call ` +
      `was stopped. A reverse proxy between the client and the tool-server must forward that ` +
      `route while the call's stream is open.`,
    { errorCode: FAILURE_CODES.FLOW_CLIENT_NOT_ANSWERING, errorKind: "network" }
  );
}

/**
 * Post a short refusal for request `id` in place of an answer that a proxy
 * refused with 413: the proxy limits the size of a request body, and an
 * answer to `read-file` carries the whole baseline. The waiting step then
 * fails at once and names the cause. True when the tool-server took it.
 */
async function refuseOversizedAnswer(
  link: ClientServicesLink,
  url: string,
  id: string,
  status: string
): Promise<boolean> {
  const refusal: ClientResponseBody = {
    id,
    ok: false,
    error:
      `the answer did not reach the tool-server (${status}). A proxy between the client and ` +
      `the tool-server limits the size of a request body. The proxy must accept a body of up ` +
      `to 48 MB on POST /invocations/<invocation>/client-responses, for example ` +
      `client_max_body_size 48m in nginx`,
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...link.headers },
      body: JSON.stringify(refusal),
      signal: AbortSignal.timeout(CLIENT_FILE_OP_TIMEOUT_MS),
    });
    await res.text().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Answer one request line and post the answer. Never rejects. Resolves to the
 * failure of the call when the answer cannot reach the tool-server: the post
 * failed, or got a reply the tool-server's answer route does not send, which
 * comes from a proxy in between. A proxy's 413 is the one such reply that
 * leaves the route open: the request is refused in a short answer instead
 * ({@link refuseOversizedAnswer}), and only when that one does not reach the
 * tool-server either does the call fail. Anything else is at most one
 * diagnostic, and the server settles the request on its side: a line without
 * a string id or invocation names no answer to post, so it is dropped. The
 * handler and the post each give up when the server would have stopped
 * waiting.
 */
async function answerClientRequest(
  link: ClientServicesLink,
  msg: ClientRequestLine
): Promise<ToolInvocationError | undefined> {
  const { id, invocation } = msg as { id?: unknown; invocation?: unknown };
  if (typeof id !== "string" || typeof invocation !== "string") {
    link.diagnose("[client-services] ignored a request line without a string id");
    return undefined;
  }
  const request = describeRequest(msg);
  const seconds = Math.round(CLIENT_FILE_OP_TIMEOUT_MS / 1000);
  let body: ClientResponseBody | undefined;
  try {
    body = await answerInTime(link, msg);
  } catch (err) {
    // The handler is built never to throw; should it, the request goes
    // unanswered like one it gave up.
    link.diagnose(`[client-services] ${request} failed on this client: ${errorText(err)}`);
    return undefined;
  }
  if (body === undefined) {
    link.diagnose(
      `[client-services] ${request} did not finish on this client within ${seconds} s, the ` +
        `time the tool-server waits for it; no answer was sent`
    );
    return undefined;
  }
  const url = link.answerUrl(invocation);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...link.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CLIENT_FILE_OP_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return undeliveredAnswer(
      request,
      url,
      timedOut ? `got no reply within ${seconds} s` : `failed: ${errorText(err)}`
    );
  }
  // Read whole, which also releases the connection: a refusal names its reason.
  const text = await res.text().catch(() => "");
  if (res.ok) return undefined;
  const refusal = answerRouteRefusal(res.status, text);
  if (refusal === undefined) {
    const status = [res.status, res.statusText].filter(Boolean).join(" ");
    if (res.status === 413 && (await refuseOversizedAnswer(link, url, id, status))) {
      link.diagnose(
        `[client-services] a proxy refused the answer to ${request} (${status}); the ` +
          `request was refused instead`
      );
      return undefined;
    }
    return undeliveredAnswer(request, url, `answered ${status}`);
  }
  link.diagnose(
    `[client-services] the tool-server did not take the answer to ${request}: ` +
      `${res.status} ${refusal}`
  );
  return undefined;
}

/**
 * The stream of a call ended before its result line: the tool may have acted
 * already, which a caller must know before it runs the tool again.
 */
function brokenStream(name: string, reason: string, progress: number, cause?: unknown): Error {
  const ran =
    progress > 0
      ? `${progress} progress update${progress === 1 ? "" : "s"} had arrived, so the tool ran at ` +
        `least in part`
      : `The tool may have run`;
  return new Error(
    `The connection to the tool-server closed before ${name} finished (${reason}). ${ran}; ` +
      `check its effect before you run it again.`,
    cause === undefined ? undefined : { cause }
  );
}

/** Read an NDJSON tool-invocation stream, mirroring the buffered path's contract. */
async function consumeToolStream(
  name: string,
  body: ReadableStream<Uint8Array>,
  onProgress: (event: unknown) => void,
  services?: ClientServicesLink
): Promise<ToolInvocationResult> {
  let final: { data?: unknown; note?: string } | undefined;
  let progress = 0;
  // The first answer that could not reach the tool-server. It fails the call
  // unless the stream delivered its result first.
  let undelivered: ToolInvocationError | undefined;
  const reader = body.getReader();
  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as {
      event?: string;
      data?: unknown;
      note?: string;
      error?: string;
      error_code?: string;
      error_kind?: string;
    };
    if (msg.event === "progress") {
      progress++;
      onProgress(msg.data);
    } else if (msg.event === CLIENT_REQUEST_EVENT) {
      // Without a handler the line is ignored, as any unknown event is. An
      // answer is never awaited: the tool-server sends the result or error
      // line only once every request was answered or timed out, so an answer
      // still in flight when the stream ends settles nothing.
      if (!services) return;
      void answerClientRequest(services, msg as ClientRequestLine).then((failure) => {
        if (failure === undefined || undelivered) return;
        // Rather than wait out the server's timeout for an answer that will
        // not come, hang up: the server then stops the call, and the read
        // loop ends with this failure.
        undelivered = failure;
        void reader.cancel().catch(() => {});
      });
    } else if (msg.event === "result") final = { data: msg.data, note: msg.note };
    else if (msg.event === "error") {
      throw new ToolInvocationError(msg.error ?? "tool invocation failed", {
        errorCode: msg.error_code,
        errorKind: msg.error_kind,
      });
    }
  };

  const decoder = new TextDecoder();
  // The pieces of the line that has not ended yet, joined once its newline
  // arrives. A request line can carry a baseline as base64, tens of MB: adding
  // each chunk to one string and searching that string again would copy and
  // scan the whole line once per chunk.
  let pieces: string[] = [];
  const take = (text: string): void => {
    let start = 0;
    let newline: number;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      pieces.push(text.slice(start, newline));
      const line = pieces.join("");
      pieces = [];
      start = newline + 1;
      handleLine(line);
    }
    if (start < text.length) pieces.push(text.slice(start));
  };
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw (
          undelivered ??
          brokenStream(name, err instanceof Error ? err.message : String(err), progress, err)
        );
      }
      const { done, value } = chunk;
      if (done) break;
      take(decoder.decode(value, { stream: true }));
    }
    // A hang-up leaves at most a cut line behind.
    if (!undelivered) {
      take(decoder.decode());
      const last = pieces.join("");
      if (last.trim()) handleLine(last);
    }
  } catch (err) {
    // Release the stream before surfacing the error.
    void reader.cancel().catch(() => {});
    throw err;
  }

  if (!final) {
    throw undelivered ?? brokenStream(name, "the stream ended without a result", progress);
  }
  // File boundary, inbound: same directive handling as the buffered path.
  const { result: data } = await applyClientFileDirectives(final.data);
  return { data, note: final.note };
}

/**
 * A schema rejection sends the raw issue JSON in `error`, which is what a CLI
 * released before `issues` parses, and the prose in `message`. Every other error
 * body sends `error` alone.
 */
export function errorBodyMessage(body: {
  error?: string;
  message?: string;
  issues?: unknown;
}): string | undefined {
  if (Array.isArray(body.issues) && typeof body.message === "string") return body.message;
  return body.error ?? body.message;
}

/**
 * The handler for one call, or null; then the call carries no
 * `client_services` and is not made a stream for them. Null when the root
 * flow composes nothing ({@link createClientServicesHandler}), and for
 * arguments the tool-server refuses before it asks for anything: a
 * `project_root` or `flow_path` that is not absolute or has a `..` segment, a
 * `flow_path` not named `<flow-name>.yaml`, a `name` outside the flow-name
 * pattern, or not exactly one of `flow_path` and `name`. Roots taken from
 * those would reach a server that does not refuse them.
 *
 * The handler serves the root flow and what it composes, inside these roots:
 * the project, its `.argent/flows` directory (a project may keep that one as
 * a symlink to a tree outside the project, and the flows there are still the
 * project's own), the directory of `flow_path` when given, so a flow
 * addressed outside the project can still reach its own fragments, and the
 * directory the root flow file REALLY lives in: a `run:` target resolves
 * beside the real file, as it does on one computer, so a root flow that is a
 * symlink serves the fragments next to its target. A root flow saved under
 * `<P>/.argent/flows/`, by its spelling or by its real path, also serves the
 * project `<P>` it belongs to: the CLI sends its working directory as
 * `project_root`, and the flow's fragments in its own project must not depend
 * on where the shell stands. Every root is served by its real location; one
 * that does not exist is dropped.
 */
async function clientServicesHandlerFor(
  advert: ClientServicesAdvert,
  args: unknown,
  log: (line: string) => void
): Promise<ClientServicesHandler | null> {
  if (typeof args !== "object" || args === null) return null;
  const { project_root, flow_path, name } = args as Record<string, unknown>;
  if (!isResolvedAbsolute(project_root)) return null;
  const flowsDir = path.join(project_root, ".argent", "flows");
  let rootFlow: string;
  if (flow_path !== undefined && name === undefined) {
    if (!isResolvedAbsolute(flow_path)) return null;
    if (!FLOW_FILE_NAME_PATTERN.test(path.basename(flow_path))) return null;
    rootFlow = flow_path;
  } else if (name !== undefined && flow_path === undefined) {
    if (typeof name !== "string" || !FLOW_NAME_PATTERN.test(name)) return null;
    rootFlow = path.join(flowsDir, `${name}.yaml`);
  } else {
    return null;
  }
  const roots = [project_root, flowsDir, path.dirname(rootFlow)];
  // Only the real file of a YAML flow adds its directory, the rule
  // resolve-file applies: a committed link to a directory or another kind of
  // file must not widen what this client serves.
  const resolved = await realpath(rootFlow).catch(() => null);
  const real =
    resolved !== null &&
    /\.ya?ml$/i.test(resolved) &&
    (await stat(resolved).then(
      (st) => st.isFile(),
      () => false
    ))
      ? resolved
      : null;
  let baselineDir: string | null = null;
  if (real !== null) {
    roots.push(path.dirname(real));
    // Where the tool-server keys this run's baselines: beside the root flow's
    // real file (the canonical that resolve-file answers for it), under that
    // file's stem, or under the flow name when the stem is not a flow name (a
    // `.yml` file, a name with a space). The flow name is `name`, or the
    // basename of `flow_path`.
    const stem = path.basename(real, ".yaml");
    const key = FLOW_NAME_PATTERN.test(stem) ? stem : path.basename(rootFlow, ".yaml");
    baselineDir = path.join(path.dirname(real), "__baselines__", key);
  }
  for (const file of real === null ? [rootFlow] : [rootFlow, real]) {
    const project = savedFlowProject(file);
    if (project !== null) roots.push(project);
  }
  const updatesBaselines = (args as Record<string, unknown>).updateBaselines === true;
  return createClientServicesHandler({
    roots,
    rootFlow,
    advertised: advert.ops.filter((op) => op !== "write-file" || updatesBaselines),
    baselineDir,
    log,
  });
}

/** An absolute path with no `..` segment, as the tool-server requires. */
function isResolvedAbsolute(value: unknown): value is string {
  return (
    typeof value === "string" && path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..")
  );
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
 * Refuses a call that lacks a required argument, with the words the
 * tool-server uses for a missing argument. Over a link, file inputs travel
 * with the call, so a call the tool-server would refuse must not send them
 * first. Presence only: a present but invalid
 * value is the tool-server's call. A target that the client derives from other
 * arguments (`flow_file` from `name`) is left to the tool-server.
 */
function assertRequiredPresent(meta: ToolMeta, args: unknown): void {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const schema = meta.inputSchema as {
    required?: unknown;
    properties?: Record<string, { type?: unknown; enum?: unknown }>;
  };
  const derived = new Set(
    (meta.fileInputs ?? [])
      .filter((spec) => spec.path !== `\${${spec.target}}`)
      .map((spec) => spec.target)
  );
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter(
    (name): name is string =>
      typeof name === "string" && !derived.has(name) && record[name] === undefined
  );
  if (missing.length === 0) return;
  // Issues in the shape the tool-server's zod check produces for an absent
  // field, so the message reads as it would from the tool-server. zod names an
  // integer field's type `number`.
  const issues = missing.map((name) => {
    const property = schema.properties?.[name];
    const type = property?.enum === undefined ? property?.type : undefined;
    const expected = type === "integer" ? "number" : typeof type === "string" ? type : undefined;
    return { code: "invalid_type", path: [name], message: "", expected };
  });
  throw new ToolInvocationError(
    describeParamIssues({ issues } as unknown as Parameters<typeof describeParamIssues>[0], record)
  );
}

/** True when a prepared argument names an upload that the tool-server will consume. */
function carriesUpload(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  return Object.values(args).some((value) => {
    const wire = value as Partial<FileInputWire> | null;
    return wire?.[FILE_INPUT_MARKER] === true && typeof wire.uploadId === "string";
  });
}

export function createToolsClient(options: CreateToolsClientOptions = {}): ToolsClient {
  let cached: ToolsServerHandle | null = null;
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const diagnose =
    options.onDiagnostic ?? ((message: string) => void process.stderr.write(`${message}\n`));

  // The handle and the file-input mode come from one resolution, so a call
  // never sends to one tool-server with the file rules of another.
  async function route(): Promise<ToolsServerHandle & { remote: boolean }> {
    if (options.baseUrl) return options.baseUrl();
    // Precedence lives in getResolvedToolsUrl. An override without a token means
    // the caller owns an unauthenticated server; with no override, auto-spawn a
    // local, token-authenticated one.
    const resolved = await getResolvedToolsUrl();
    if (resolved.url) {
      return { url: resolved.url, token: resolved.token ?? "", remote: true };
    }
    if (!cached) {
      if (!options.paths) {
        throw new Error(
          "tools-client: cannot spawn tool-server without `paths`; set ARGENT_TOOLS_URL or pass paths to createToolsClient()"
        );
      }
      cached = await ensureToolsServer(options.paths);
    }
    return { ...cached, remote: false };
  }

  async function baseUrl(): Promise<ToolsServerHandle> {
    const { url, token } = await route();
    return { url, token };
  }

  async function fetchTools(): Promise<ToolMeta[]> {
    const { url, token } = await baseUrl();
    const res = await doFetch(
      `${url}/tools`,
      { headers: authHeaders(token) },
      { longRunning: false, carriesUpload: false }
    );
    if (!res.ok) throw new Error(`GET /tools failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { tools: ToolMeta[] };
    return json.tools;
  }

  async function fetchTool(name: string): Promise<ToolMeta | null> {
    const tools = await fetchTools();
    return tools.find((t) => t.name === name) ?? null;
  }

  async function callTool(
    name: string,
    args: unknown,
    opts?: CallToolOptions
  ): Promise<ToolInvocationResult> {
    const { url, token, remote } = await route();

    // File boundary, outbound: wrap args the tool declares as file paths so the
    // server can read them in place (local) or from inlined content (routed).
    // Client services, outbound: offer to serve project files during the call
    // when the tool can ask for them and the call is routed.
    let finalArgs = args;
    let services: ClientServicesLink | undefined;
    const meta = await fetchTool(name);
    if (meta?.fileInputs?.length || meta?.clientServices) {
      if (meta.fileInputs?.length) {
        if (remote) assertRequiredPresent(meta, args);
        finalArgs = await prepareFileInputs(meta.fileInputs, args ?? {}, {
          includeContent: remote,
          uploadEndpoint: remote ? { url, token } : undefined,
        });
      }
      if (remote && meta.clientServices) {
        const handler = await clientServicesHandlerFor(meta.clientServices, args, diagnose);
        if (handler) {
          finalArgs = { ...(finalArgs as Record<string, unknown>), client_services: handler.param };
          services = {
            handler,
            answerUrl: (invocation) =>
              `${url}/invocations/${encodeURIComponent(invocation)}/client-responses`,
            headers: authHeaders(token),
            diagnose,
          };
        }
      }
    }

    // A handler needs the stream: its requests travel on it.
    const stream = opts?.onProgress !== undefined || services !== undefined;
    const res = await doFetch(
      `${url}/tools/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // A proxy that compresses the stream holds each line until its buffer
          // fills, so a request line never gets its answer. `identity` keeps the
          // stream uncompressed end to end.
          ...(stream ? { "Accept": "application/x-ndjson", "Accept-Encoding": "identity" } : {}),
          ...authHeaders(token),
        },
        body: JSON.stringify(finalArgs ?? {}),
      },
      { longRunning: meta?.longRunning === true, carriesUpload: carriesUpload(finalArgs) }
    );
    // The server commits to streaming only after every pre-invoke gate passes —
    // validation errors stay plain JSON with their status codes — so Content-Type
    // is the authoritative mode signal.
    const contentType = res.headers.get("content-type") ?? "";
    if (stream && res.ok && res.body && contentType.includes("application/x-ndjson")) {
      const streamed = await consumeToolStream(
        name,
        res.body,
        opts?.onProgress ?? (() => {}),
        services
      );
      return { ...streamed, outputHint: meta?.outputHint };
    }
    let json: {
      data?: unknown;
      error?: string;
      message?: string;
      note?: string;
      error_code?: string;
      error_kind?: string;
      issues?: unknown;
    };
    try {
      json = (await res.json()) as typeof json;
    } catch (err) {
      // A 2xx whose body cannot be read (a proxy's own page, a connection cut
      // mid-answer) is not a result: the tool may have run, but its outcome is
      // lost. An error status keeps its `<status> <statusText>` fallback below.
      if (res.ok) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `The tool-server answered ${res.status} ${res.statusText} to ${name}, but the answer could not be read (${reason}). ` +
            `The tool may have run; check its effect before you run it again.`,
          { cause: err }
        );
      }
      json = {};
    }
    if (!res.ok) {
      throw new ToolInvocationError(errorBodyMessage(json) ?? `${res.status} ${res.statusText}`, {
        errorCode: json.error_code,
        errorKind: json.error_kind,
        issues: Array.isArray(json.issues) ? json.issues : undefined,
      });
    }
    // File boundary, inbound: persist client-write directives (e.g. recorded
    // flow YAMLs) and rewrite them to the written paths.
    const { result: data } = await applyClientFileDirectives(json.data);
    return { data, note: json.note, outputHint: meta?.outputHint };
  }

  return { fetchTools, fetchTool, callTool, baseUrl };
}
