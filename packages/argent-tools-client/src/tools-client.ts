import { ensureToolsServer, type ToolsServerHandle, type ToolsServerPaths } from "./launcher.js";
import { getResolvedToolsUrl } from "./link-config.js";
import { prepareFileInputs, applyClientFileDirectives, type FileInputSpec } from "./file-inputs.js";

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

export function createToolsClient(options: CreateToolsClientOptions = {}): ToolsClient {
  let cached: ToolsServerHandle | null = null;

  async function baseUrl(): Promise<ToolsServerHandle> {
    // Precedence lives in getResolvedToolsUrl. An override without a token means
    // the caller owns an unauthenticated server; with no override, auto-spawn a
    // local, token-authenticated one.
    const resolved = await getResolvedToolsUrl();
    if (resolved.url) {
      return { url: resolved.url, token: resolved.token ?? "" };
    }
    if (cached) return cached;
    if (!options.paths) {
      throw new Error(
        "tools-client: cannot spawn tool-server without `paths`; set ARGENT_TOOLS_URL or pass paths to createToolsClient()"
      );
    }
    cached = await ensureToolsServer(options.paths);
    return cached;
  }

  async function fetchTools(): Promise<ToolMeta[]> {
    const { url, token } = await baseUrl();
    const res = await fetch(`${url}/tools`, { headers: authHeaders(token) });
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
    const { url, token } = await baseUrl();

    // File boundary, outbound: wrap args the tool declares as file paths so the
    // server can read them in place (co-located) or from inlined content (remote).
    let finalArgs = args;
    const meta = await fetchTool(name);
    if (meta?.fileInputs?.length) {
      const { url: routedUrl } = await getResolvedToolsUrl();
      const isRemote = routedUrl !== null;
      finalArgs = await prepareFileInputs(meta.fileInputs, args ?? {}, {
        includeContent: isRemote,
        uploadEndpoint: isRemote ? { url, token } : undefined,
      });
    }

    const res = await fetch(`${url}/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts?.onProgress ? { Accept: "application/x-ndjson" } : {}),
        ...authHeaders(token),
      },
      body: JSON.stringify(finalArgs ?? {}),
    });
    // The server commits to streaming only after every pre-invoke gate passes —
    // validation errors stay plain JSON with their status codes — so Content-Type
    // is the authoritative mode signal.
    const contentType = res.headers.get("content-type") ?? "";
    if (opts?.onProgress && res.ok && res.body && contentType.includes("application/x-ndjson")) {
      return consumeToolStream(res.body, opts.onProgress);
    }
    const json = (await res.json().catch(() => ({}))) as {
      data?: unknown;
      error?: string;
      message?: string;
      note?: string;
      error_code?: string;
      error_kind?: string;
      issues?: unknown;
    };
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
    return { data, note: json.note };
  }

  return { fetchTools, fetchTool, callTool, baseUrl };
}
