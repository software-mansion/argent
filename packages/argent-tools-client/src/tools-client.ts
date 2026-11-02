import { readFile } from "node:fs/promises";
import { maxHeaderSize } from "node:http";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  encodeClientSecrets,
  isFeatureEnabled,
  lookupPlaceholderSecret,
  placeholderNames,
  secretSources,
} from "@argent/configuration-core";
import {
  CLIENT_SECRETS_HEADER,
  E2E_DIR_CLIENT_HEADER,
  LEGACY_E2E_DIRS,
  LINKED_CALL_HEADER,
  canonicalToolId,
  describeParamIssues,
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
import {
  collectFlowMembers,
  collectStepMembers,
  e2eShadowWarningFor,
  filesLogEnabled,
  nameToE2ePathForOlderServer,
  stepForOlderServer,
} from "./flow-files.js";
import { ToolInvocationError } from "./errors.js";

export interface ToolMeta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputHint?: string;
  /** Args that name files on the CALLER's machine — see file-inputs.ts. */
  fileInputs?: FileInputSpec[];
  alwaysLoad?: boolean;
  searchHint?: string;
  longRunning?: boolean;
  /** Listed for programmatic callers only; the MCP adapter skips it. */
  hideFromMcp?: boolean;
  readOnly?: boolean;
  /** Set on a former id of a tool: the tool's current id. */
  aliasOf?: string;
}

export interface ToolInvocationResult {
  data: unknown;
  note?: string;
  /** Set when a profiler was recording on the call's device as the call completed. */
  profiling?: boolean;
  /** The `outputHint` of the tool's listing entry, when it has one. */
  outputHint?: string;
}

export interface CallToolOptions {
  /**
   * Receive live progress events while the tool runs, by asking the server for
   * an NDJSON stream. A server that answers with plain JSON fires no events.
   */
  onProgress?: (event: unknown) => void;
  /**
   * Stop waiting for the call. Every request rejects with the signal's reason,
   * as `fetch` does, never with a ToolInvocationError.
   */
  signal?: AbortSignal;
}

export interface ToolsClient {
  fetchTools(opts?: { signal?: AbortSignal }): Promise<ToolMeta[]>;
  fetchTool(name: string, opts?: { signal?: AbortSignal }): Promise<ToolMeta | null>;
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
   * request. POST /upload keeps the global fetch.
   */
  fetchImpl?: (
    url: string,
    init: RequestInit,
    meta: { longRunning: boolean; carriesUpload: boolean }
  ) => Promise<Response>;
  /**
   * Receives each diagnostic line of the client, without a trailing newline:
   * the `[flow-files]` lines that `ARGENT_E2E_FILES_LOG=1` turns on, and each
   * snapshot baseline a run returned that could not be written here.
   * Defaults to writing the line to stderr; `argent flow run --json` turns it
   * into a JSON record, since its stderr carries one JSON object per line.
   */
  onDiagnostic?: (message: string) => void;
  /**
   * Headers added to GET /tools and POST /tools/:name. Set here rather than in
   * `fetchImpl`, so they count toward the header limit a call that forwards
   * secrets is checked against.
   */
  headers?: () => Record<string, string>;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * The connection of a call closed before its result arrived, during its
 * stream or before its answer: the tool may have acted already, which a
 * caller must know before it runs the tool again.
 */
function brokenStream(
  name: string,
  reason: string,
  progress: number,
  cause?: unknown
): ToolInvocationError {
  const ran =
    progress > 0
      ? `${progress} progress update${progress === 1 ? "" : "s"} had arrived, so the tool ran at ` +
        `least in part`
      : `The tool may have run`;
  return new ToolInvocationError(
    `The connection to the tool-server closed before ${name} finished (${reason}). ${ran}; ` +
      `check its effect before you run it again.`,
    undefined,
    cause === undefined ? undefined : { cause }
  );
}

/** Read an NDJSON tool-invocation stream, mirroring the buffered path's contract. */
async function consumeToolStream(
  name: string,
  body: ReadableStream<Uint8Array>,
  onProgress: (event: unknown) => void,
  signal?: AbortSignal
): Promise<ToolInvocationResult> {
  let final: { data?: unknown; note?: string; profiling?: boolean } | undefined;
  let progress = 0;
  const reader = body.getReader();
  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as {
      event?: string;
      data?: unknown;
      note?: string;
      profiling?: boolean;
      error?: string;
      error_code?: string;
      error_kind?: string;
    };
    if (msg.event === "progress") {
      progress++;
      onProgress(msg.data);
    } else if (msg.event === "result") {
      final = {
        data: msg.data,
        note: msg.note,
        ...(msg.profiling === true ? { profiling: true } : {}),
      };
    } else if (msg.event === "error") {
      throw new ToolInvocationError(msg.error ?? "tool invocation failed", {
        errorCode: msg.error_code,
        errorKind: msg.error_kind,
      });
    }
  };

  const decoder = new TextDecoder();
  // The pieces of the line that has not ended yet, joined once its newline
  // arrives. The result line can carry baselines as base64, tens of MB:
  // adding each chunk to one string and searching that string again would
  // copy and scan the whole line once per chunk.
  let pieces: string[] = [];
  const take = (text: string): void => {
    let start = 0;
    let newline: number;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      // fetch errors the body on abort, but not a chunk it already handed over.
      signal?.throwIfAborted();
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
        // fetch errors the body on abort, which is not a closed connection.
        signal?.throwIfAborted();
        throw brokenStream(name, err instanceof Error ? err.message : String(err), progress, err);
      }
      const { done, value } = chunk;
      if (done) break;
      take(decoder.decode(value, { stream: true }));
    }
    take(decoder.decode());
    const last = pieces.join("");
    if (last.trim()) handleLine(last);
  } catch (err) {
    // Release the stream before surfacing the error.
    void reader.cancel().catch(() => {});
    throw err;
  }

  // Before the missing-result check: a trailing progress callback may abort.
  signal?.throwIfAborted();
  if (!final) {
    throw brokenStream(name, "the stream ended without a result", progress);
  }
  return {
    data: final.data,
    note: final.note,
    ...(final.profiling ? { profiling: true } : {}),
  };
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
 * The tool `name` names: the one listed under it, else the one listed under
 * its current or former id, so an `e2e-*` call reaches an older tool-server
 * that lists only `flow-*`.
 */
function findTool(tools: readonly ToolMeta[], name: string): ToolMeta | null {
  const id = canonicalToolId(name);
  return (
    tools.find((t) => t.name === name) ?? tools.find((t) => canonicalToolId(t.name) === id) ?? null
  );
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

/** A rejected fetch's reason, with undici's cause ("other side closed") beside its "fetch failed". */
function fetchFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

function wiresOf(args: unknown): Partial<FileInputWire>[] {
  if (typeof args !== "object" || args === null) return [];
  return Object.values(args).filter(
    (value): value is Partial<FileInputWire> =>
      (value as Partial<FileInputWire> | null)?.[FILE_INPUT_MARKER] === true
  );
}

/**
 * True when a prepared argument carries `members`, an empty list included
 * (see file-inputs.ts `collect`): the call runs a flow over a link.
 */
function carriesMembers(args: unknown): boolean {
  return wiresOf(args).some((wire) => Array.isArray(wire.members));
}

/**
 * True when a prepared argument names an upload that the tool-server will
 * consume, or carries members: a call that runs a flow over a link is never
 * sent twice, so a run's steps never act on the device twice.
 */
function carriesUpload(args: unknown): boolean {
  return carriesMembers(args) || wiresOf(args).some((wire) => typeof wire.uploadId === "string");
}

/**
 * With `forward-secrets` on, the value on this machine of each secret a
 * placeholder in `args` names, the e2e tests a call sends included; undefined
 * when the call names none. A name this machine lacks is left to the
 * tool-server, so the map can be empty.
 */
async function forwardedSecrets(args: unknown): Promise<Map<string, string> | undefined> {
  if (!isFeatureEnabled("forward-secrets")) return undefined;
  const names = new Set<string>();
  const scan = (text: string): void => {
    for (const name of placeholderNames(text)) names.add(name);
  };
  // A YAML alias can refer back to its own anchor, which parses to a cycle.
  const seen = new WeakSet<object>();
  const visit = async (value: unknown): Promise<void> => {
    if (typeof value === "string") return scan(value);
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    const wire = value as Partial<FileInputWire>;
    if (wire[FILE_INPUT_MARKER] !== true) {
      for (const nested of Object.values(value)) await visit(nested);
      return;
    }
    // Only a call that runs the file sends its closure as `members`; a tool
    // that merely reads a test types none of its placeholders.
    if (!Array.isArray(wire.members)) return;
    const yaml = [
      ...(/\.ya?ml$/i.test(wire.path ?? "") ? [wire] : []),
      ...wire.members.filter((member) => member.role === "flow"),
    ];
    for (const file of yaml) {
      let text: string | undefined;
      if (typeof file.content === "string") {
        text = Buffer.from(file.content, "base64").toString("utf8");
      } else if (file.uploadId !== undefined && file.canonical !== undefined) {
        // Sent through `POST /upload`, so read where it was sent from. Gone
        // since then, it leaves its names to the tool-server.
        text = await readFile(file.canonical, "utf8").catch(() => undefined);
      }
      // The parsed values, as the runner parses them: a long string can fold
      // inside a placeholder, and a comment is never typed. A file that does
      // not parse fails on the tool-server too, and its warnings belong to the
      // run, not to this terminal.
      let parsed: unknown;
      try {
        parsed = text === undefined ? undefined : parseYaml(text.trim(), { logLevel: "error" });
      } catch {
        continue;
      }
      await visit(parsed);
    }
  };
  await visit(args);
  if (names.size === 0) return undefined;
  const sources = secretSources();
  const values = new Map<string, string>();
  for (const rawName of names) {
    const { name, value } = lookupPlaceholderSecret(rawName, sources);
    if (value !== undefined) values.set(name, value);
  }
  return values;
}

/**
 * Why `forward-secrets` may not send values to `url`, and how to fix it; else
 * undefined. The values cross the wire as plain header text, so only over
 * verified TLS or to this machine.
 */
export function secretsTransportRefusal(url: string): string | undefined {
  if (!URL.canParse(url)) return `${url} is not a URL`;
  const { protocol, hostname } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, "");
  if (["127.0.0.1", "localhost", "::1"].includes(host)) return undefined;
  if (protocol !== "https:") {
    return (
      `${url} is reached neither over https:// nor at a loopback address. Link the tool-server ` +
      `through an https:// URL, or through an SSH tunnel to a 127.0.0.1 port`
    );
  }
  // The one value Node reads as "skip certificate checks", fetch included.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    return (
      `NODE_TLS_REJECT_UNAUTHORIZED=0 turns off the certificate check of ${url}. Unset it, and ` +
      `trust a self-signed certificate through NODE_EXTRA_CA_CERTS instead`
    );
  }
  return undefined;
}

/** Upper bound of the head bytes fetch adds to a call's own headers and URL. */
const FETCH_HEAD_BYTES = 256;

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

  async function fetchTools(opts?: { signal?: AbortSignal }): Promise<ToolMeta[]> {
    opts?.signal?.throwIfAborted();
    const { url, token } = await baseUrl();
    const res = await doFetch(
      `${url}/tools`,
      { headers: { ...options.headers?.(), ...authHeaders(token) }, signal: opts?.signal },
      { longRunning: false, carriesUpload: false }
    );
    if (!res.ok) throw new Error(`GET /tools failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { tools: ToolMeta[] };
    return json.tools;
  }

  async function fetchTool(
    name: string,
    opts?: { signal?: AbortSignal }
  ): Promise<ToolMeta | null> {
    return findTool(await fetchTools(opts), name);
  }

  async function callTool(
    name: string,
    args: unknown,
    opts?: CallToolOptions
  ): Promise<ToolInvocationResult> {
    // An aborted signal must not start a tool-server.
    opts?.signal?.throwIfAborted();
    const { url, token, remote } = await route();

    // File boundary, outbound: wrap args the tool declares as file paths so the
    // server can read them in place (local) or from inlined content (routed).
    let finalArgs = args;
    const tools = await fetchTools({ signal: opts?.signal });
    const meta = findTool(tools, name);
    // An older tool-server reads saved tests only from `.argent/flows/`, and
    // lists its tools by their `flow-*` ids only.
    const olderServer = meta !== null && !tools.some((t) => t.name === canonicalToolId(meta.name));
    if (meta) {
      finalArgs = await nameToE2ePathForOlderServer(meta.name, meta.fileInputs, args);
    }
    if (olderServer && canonicalToolId(meta.name) === "e2e-add-step") {
      finalArgs = await stepForOlderServer(finalArgs, (tool) => findTool(tools, tool)?.name);
    }
    // Picked here when the tool-server does not read the test in place.
    const shadowWarning = await e2eShadowWarningFor(name, args);
    // Where a baseline the result returns may be written (see file-inputs.ts).
    const baselineDirs: string[] = [];
    if (meta?.fileInputs?.length) {
      if (remote) assertRequiredPresent(meta, finalArgs);
      finalArgs = await prepareFileInputs(meta.fileInputs, finalArgs ?? {}, {
        includeContent: remote,
        uploadEndpoint: remote ? { url, token } : undefined,
        log: diagnose,
        baselineDirs,
        collectMembers: collectFlowMembers,
        collectStepMembers: olderServer
          ? (record, o) =>
              collectStepMembers(record, o, (root) => path.join(root, LEGACY_E2E_DIRS[0]!))
          : collectStepMembers,
        toolFileInputs: (tool) => findTool(tools, tool)?.fileInputs,
        signal: opts?.signal,
      });
    }
    // File boundary, inbound: persist client-write directives (recorded flow
    // YAMLs, a run's new baselines) and rewrite them to the written paths. A
    // baseline that could not be written is said here, and stays in the
    // result as `{ path, error }`. A shadowed legacy test the tool-server did
    // not see is said in the result's `warning`, as it says one it sees.
    const settle = async (data: unknown): Promise<unknown> => {
      const applied = await applyClientFileDirectives(data, { allowedDirs: baselineDirs });
      for (const { path: file, error } of applied.failed) {
        diagnose(`The baseline ${file} was not written on this client: ${error}`);
      }
      if (filesLogEnabled()) {
        // A recorded flow YAML is written here too; only baselines are logged.
        for (const file of applied.written) {
          if (baselineDirs.includes(path.dirname(file))) {
            diagnose(`[flow-files] baseline ${file}: written`);
          }
        }
      }
      const result = applied.result;
      if (
        shadowWarning === undefined ||
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result) ||
        typeof (result as { warning?: unknown }).warning === "string"
      ) {
        return result;
      }
      return { ...result, warning: shadowWarning };
    };

    // A call that sends a flow's closure runs that flow over a link, and its
    // progress lines keep the connection busy through a proxy's idle timeout.
    const stream = opts?.onProgress !== undefined || carriesMembers(finalArgs);
    const sentOnce = carriesUpload(finalArgs);
    const forwarded = remote ? await forwardedSecrets(finalArgs) : undefined;
    // Sent even when empty: an unknown-secret error can then say the client
    // was asked and had no value.
    const encodedSecrets = forwarded ? encodeClientSecrets(forwarded) : undefined;
    const clientSecrets = forwarded?.size ? forwarded : undefined;
    const refusal = clientSecrets ? secretsTransportRefusal(url) : undefined;
    if (refusal !== undefined) {
      throw new Error(
        `forward-secrets sends secret values only over https:// with the certificate checked, or to ` +
          `a loopback address, so the call was not sent (it names ` +
          `${[...clientSecrets!.keys()].join(", ")}): ${refusal}.`
      );
    }
    const toolUrl = `${url}/tools/${encodeURIComponent(meta?.name ?? name)}`;
    const headers: Record<string, string> = {
      ...options.headers?.(),
      "Content-Type": "application/json",
      // Tells the tool-server the call came over a link, a link to
      // 127.0.0.1 included, which nothing else in the request shows.
      ...(remote ? { [LINKED_CALL_HEADER]: "1" } : {}),
      // Tells the tool-server this client writes recordings under
      // `.argent/e2e/`; an older client writes only `.argent/flows/`.
      [E2E_DIR_CLIENT_HEADER]: "1",
      ...(encodedSecrets ? { [CLIENT_SECRETS_HEADER]: encodedSecrets } : {}),
      // A proxy that compresses the stream holds each line until its buffer
      // fills. `identity` keeps the stream uncompressed end to end.
      ...(stream ? { "Accept": "application/x-ndjson", "Accept-Encoding": "identity" } : {}),
      ...authHeaders(token),
    };
    if (clientSecrets !== undefined && encodedSecrets !== undefined) {
      // Node's limit counts the whole head, fetch's own headers included. Past
      // it the tool-server refuses the call, and with a large body the socket
      // closes mid-send instead of answering 431.
      const headBytes =
        toolUrl.length +
        FETCH_HEAD_BYTES +
        Object.entries(headers).reduce(
          (sum, [key, value]) => sum + key.length + value.length + 4,
          0
        );
      if (headBytes > maxHeaderSize) {
        throw new Error(
          `forward-secrets would send ${[...clientSecrets!.keys()].join(", ")} in an ` +
            `${CLIENT_SECRETS_HEADER} header of ${encodedSecrets.length} bytes, which takes the request ` +
            `headers past the ${maxHeaderSize} bytes a tool-server accepts, so the call was not sent. ` +
            `Define a secret this large on the machine running the tool-server instead.`
        );
      }
    }
    const res = await doFetch(
      toolUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify(finalArgs ?? {}),
        signal: opts?.signal,
        // A followed redirect would re-send the values to wherever it points.
        ...(clientSecrets ? { redirect: "manual" as const } : {}),
      },
      { longRunning: meta?.longRunning === true, carriesUpload: sentOnce }
    ).catch((err: unknown) => {
      // An abort rejects with the signal's reason, not as a closed connection.
      opts?.signal?.throwIfAborted();
      // A call that is sent once may have reached the tool-server before its
      // connection closed, and nothing sends it again.
      if (!sentOnce) throw err;
      throw brokenStream(name, fetchFailure(err), 0, err);
    });
    // The server commits to streaming only after every pre-invoke gate passes —
    // validation errors stay plain JSON with their status codes — so Content-Type
    // is the authoritative mode signal.
    const contentType = res.headers.get("content-type") ?? "";
    if (stream && res.ok && res.body && contentType.includes("application/x-ndjson")) {
      const streamed = await consumeToolStream(
        name,
        res.body,
        opts?.onProgress ?? (() => {}),
        opts?.signal
      );
      return {
        data: await settle(streamed.data),
        note: streamed.note,
        outputHint: meta?.outputHint,
        ...(streamed.profiling ? { profiling: true } : {}),
      };
    }
    let json: {
      data?: unknown;
      error?: string;
      message?: string;
      note?: string;
      profiling?: boolean;
      error_code?: string;
      error_kind?: string;
      issues?: unknown;
    };
    try {
      json = (await res.json()) as typeof json;
    } catch (err) {
      // An abort while reading the body is not an empty body.
      opts?.signal?.throwIfAborted();
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
    if (clientSecrets && res.status >= 300 && res.status < 400) {
      throw new ToolInvocationError(
        `The tool-server answered ${res.status} ${res.statusText} to ${name}. forward-secrets does not ` +
          `follow a redirect, so the call was not sent on; link the URL it points to instead.`
      );
    }
    // nginx answers an oversized header with a 400 page, which carries no error body.
    const headersRefused =
      res.status === 431 || (res.status === 400 && errorBodyMessage(json) === undefined);
    if (clientSecrets && headersRefused) {
      throw new ToolInvocationError(
        `The tool-server, or a proxy in front of it, refused the request headers (${res.status}), ` +
          `as it does when they are too large. The ${CLIENT_SECRETS_HEADER} header carried ` +
          `${[...clientSecrets.keys()].join(", ")}; define a secret this large on the machine ` +
          `running the tool-server instead.`
      );
    }
    if (!res.ok) {
      throw new ToolInvocationError(errorBodyMessage(json) ?? `${res.status} ${res.statusText}`, {
        errorCode: json.error_code,
        errorKind: json.error_kind,
        issues: Array.isArray(json.issues) ? json.issues : undefined,
      });
    }
    opts?.signal?.throwIfAborted();
    return {
      data: await settle(json.data),
      note: json.note,
      outputHint: meta?.outputHint,
      ...(json.profiling === true ? { profiling: true } : {}),
    };
  }

  return { fetchTools, fetchTool, callTool, baseUrl };
}
