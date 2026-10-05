import { describeParamIssues } from "@argent/registry";
import { ensureToolsServer, type ToolsServerHandle, type ToolsServerPaths } from "./launcher.js";
import { getResolvedToolsUrl } from "./link-config.js";
import {
  prepareFileInputs,
  applyClientFileDirectives,
  FILE_INPUT_MARKER,
  type FileInputSpec,
  type FileInputWire,
} from "./file-inputs.js";

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

/** Read an NDJSON tool-invocation stream, mirroring the buffered path's contract. */
async function consumeToolStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (event: unknown) => void
): Promise<ToolInvocationResult> {
  let final: { data?: unknown; note?: string } | undefined;
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
    if (msg.event === "progress") onProgress(msg.data);
    else if (msg.event === "result") final = { data: msg.data, note: msg.note };
    else if (msg.event === "error") {
      throw new ToolInvocationError(msg.error ?? "tool invocation failed", {
        errorCode: msg.error_code,
        errorKind: msg.error_kind,
      });
    }
  };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        handleLine(line);
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) handleLine(buffered);
  } catch (err) {
    // Release the stream before surfacing the error.
    void reader.cancel().catch(() => {});
    throw err;
  }

  if (!final) {
    throw new Error("tool stream ended without a result — connection lost mid-run?");
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
    const meta = await fetchTool(name);
    if (meta?.fileInputs?.length) {
      if (remote) assertRequiredPresent(meta, args);
      finalArgs = await prepareFileInputs(meta.fileInputs, args ?? {}, {
        includeContent: remote,
        uploadEndpoint: remote ? { url, token } : undefined,
      });
    }

    const res = await doFetch(
      `${url}/tools/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts?.onProgress ? { Accept: "application/x-ndjson" } : {}),
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
    if (opts?.onProgress && res.ok && res.body && contentType.includes("application/x-ndjson")) {
      const streamed = await consumeToolStream(res.body, opts.onProgress);
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
