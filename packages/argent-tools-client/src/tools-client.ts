import * as path from "node:path";

import { LINKED_CALL_HEADER, describeParamIssues } from "@argent/registry";
import { ensureToolsServer, type ToolsServerHandle, type ToolsServerPaths } from "./launcher.js";
import { getResolvedToolsUrl } from "./link-config.js";
import {
  prepareFileInputs,
  applyClientFileDirectives,
  FILE_INPUT_MARKER,
  type FileInputSpec,
  type FileInputWire,
} from "./file-inputs.js";
import { collectFlowMembers, collectStepMembers } from "./flow-files.js";

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
   * request. POST /upload keeps the global fetch.
   */
  fetchImpl?: (
    url: string,
    init: RequestInit,
    meta: { longRunning: boolean; carriesUpload: boolean }
  ) => Promise<Response>;
  /**
   * Receives each diagnostic line of the client, without a trailing newline:
   * the `[flow-files]` lines that `ARGENT_FLOW_FILES_LOG=1` turns on, and each
   * snapshot baseline a run returned that could not be written here.
   * Defaults to writing the line to stderr; `argent flow run --json` turns it
   * into a JSON record, since its stderr carries one JSON object per line.
   */
  onDiagnostic?: (message: string) => void;
}

/**
 * A tool invocation the SERVER answered with an error — an HTTP error status or
 * the NDJSON stream's terminal `error` line — or one whose connection closed
 * after the call was sent, so that the tool may have run.
 * `errorKind`/`errorCode` carry the server's failure signal (e.g. kind
 * "validation") when it sent one.
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
    signal?: { errorCode?: string; errorKind?: string; issues?: readonly unknown[] },
    options?: ErrorOptions
  ) {
    super(message, options);
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
  onProgress: (event: unknown) => void
): Promise<ToolInvocationResult> {
  let final: { data?: unknown; note?: string } | undefined;
  let progress = 0;
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
  // arrives. The result line can carry baselines as base64, tens of MB:
  // adding each chunk to one string and searching that string again would
  // copy and scan the whole line once per chunk.
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

  if (!final) {
    throw brokenStream(name, "the stream ended without a result", progress);
  }
  return { data: final.data, note: final.note };
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
    let finalArgs = args;
    const tools = await fetchTools();
    const meta = tools.find((t) => t.name === name) ?? null;
    // Where a baseline the result returns may be written (see file-inputs.ts).
    const baselineDirs: string[] = [];
    if (meta?.fileInputs?.length) {
      if (remote) assertRequiredPresent(meta, args);
      finalArgs = await prepareFileInputs(meta.fileInputs, args ?? {}, {
        includeContent: remote,
        uploadEndpoint: remote ? { url, token } : undefined,
        log: diagnose,
        baselineDirs,
        collectMembers: collectFlowMembers,
        collectStepMembers,
        toolFileInputs: (tool) => tools.find((t) => t.name === tool)?.fileInputs,
      });
    }
    // File boundary, inbound: persist client-write directives (recorded flow
    // YAMLs, a run's new baselines) and rewrite them to the written paths. A
    // baseline that could not be written is said here, and stays in the
    // result as `{ path, error }`.
    const settle = async (data: unknown): Promise<unknown> => {
      const applied = await applyClientFileDirectives(data, { allowedDirs: baselineDirs });
      for (const { path: file, error } of applied.failed) {
        diagnose(`The baseline ${file} was not written on this client: ${error}`);
      }
      if (process.env.ARGENT_FLOW_FILES_LOG === "1") {
        // A recorded flow YAML is written here too; only baselines are logged.
        for (const file of applied.written) {
          if (baselineDirs.includes(path.dirname(file))) {
            diagnose(`[flow-files] baseline ${file}: written`);
          }
        }
      }
      return applied.result;
    };

    // A call that sends a flow's closure runs that flow over a link, and its
    // progress lines keep the connection busy through a proxy's idle timeout.
    const stream = opts?.onProgress !== undefined || carriesMembers(finalArgs);
    const sentOnce = carriesUpload(finalArgs);
    const res = await doFetch(
      `${url}/tools/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Tells the tool-server the call came over a link, a link to
          // 127.0.0.1 included, which nothing else in the request shows.
          ...(remote ? { [LINKED_CALL_HEADER]: "1" } : {}),
          // A proxy that compresses the stream holds each line until its buffer
          // fills. `identity` keeps the stream uncompressed end to end.
          ...(stream ? { "Accept": "application/x-ndjson", "Accept-Encoding": "identity" } : {}),
          ...authHeaders(token),
        },
        body: JSON.stringify(finalArgs ?? {}),
      },
      { longRunning: meta?.longRunning === true, carriesUpload: sentOnce }
    ).catch((err: unknown) => {
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
      const streamed = await consumeToolStream(name, res.body, opts?.onProgress ?? (() => {}));
      return {
        data: await settle(streamed.data),
        note: streamed.note,
        outputHint: meta?.outputHint,
      };
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
    return { data: await settle(json.data), note: json.note, outputHint: meta?.outputHint };
  }

  return { fetchTools, fetchTool, callTool, baseUrl };
}
