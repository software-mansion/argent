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
   * Receive live progress events while the tool runs. Setting this asks the
   * server for an NDJSON stream (`Accept: application/x-ndjson`); a server
   * that predates streaming ignores the header and replies with plain JSON,
   * in which case no events fire and the call behaves exactly as before.
   */
  onProgress?: (event: unknown) => void;
}

/**
 * The CLI and MCP server each instantiate a client bound to the bundled paths
 * known by the published package. Keeping it as a factory avoids a hidden
 * module-level singleton and makes testing easier.
 */
export interface ToolsClient {
  fetchTools(): Promise<ToolMeta[]>;
  fetchTool(name: string): Promise<ToolMeta | null>;
  callTool(name: string, args: unknown, opts?: CallToolOptions): Promise<ToolInvocationResult>;
  /** Returns the tool-server base URL + auth token, spawning if needed. */
  baseUrl(): Promise<ToolsServerHandle>;
}

export interface CreateToolsClientOptions {
  /** Locations of bundled artifacts. Required when ARGENT_TOOLS_URL is unset. */
  paths?: ToolsServerPaths;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Read an NDJSON tool-invocation stream: each `progress` line fires the
 * callback as it arrives, the terminal `result` line becomes the return value,
 * and a terminal `error` line throws — mirroring the buffered path's contract.
 * A stream that ends with no terminal line means the connection died mid-run.
 */
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
    };
    if (msg.event === "progress") onProgress(msg.data);
    else if (msg.event === "result") final = { data: msg.data, note: msg.note };
    else if (msg.event === "error") throw new Error(msg.error ?? "tool invocation failed");
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
    // Terminal `error` line or a mid-stream parse/read failure: drop the rest
    // of the stream (the server has ended it anyway) and surface the error.
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

export function createToolsClient(options: CreateToolsClientOptions = {}): ToolsClient {
  let cached: ToolsServerHandle | null = null;

  async function baseUrl(): Promise<ToolsServerHandle> {
    // Resolution precedence (ARGENT_TOOLS_URL env > ~/.argent/link.json > none)
    // lives in getResolvedToolsUrl. When a remote target is configured, the
    // matching auth token comes from ARGENT_AUTH_TOKEN — empty/unset means the
    // caller owns an unauthenticated server (legacy / dev). With no override
    // (the default when the user never ran `argent link`), fall through to a
    // locally auto-spawned, token-authenticated tool-server.
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

    // File boundary, outbound: wrap declared file-path args so the server can
    // read them in place (co-located) or from inlined content (remote). The
    // tool's advertised metadata drives this — an older server that doesn't
    // declare fileInputs gets the args verbatim.
    let finalArgs = args;
    const meta = await fetchTool(name);
    if (meta?.fileInputs?.length) {
      const { url: routedUrl } = await getResolvedToolsUrl();
      finalArgs = await prepareFileInputs(meta.fileInputs, args ?? {}, {
        includeContent: routedUrl !== null,
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
    // The server only streams when the request asked for it AND every
    // pre-invoke gate passed (validation errors stay plain JSON with their
    // status codes); a pre-streaming server ignores the Accept header
    // entirely. Content-Type is therefore the authoritative mode signal.
    const contentType = res.headers.get("content-type") ?? "";
    if (opts?.onProgress && res.ok && res.body && contentType.includes("application/x-ndjson")) {
      return consumeToolStream(res.body, opts.onProgress);
    }
    const json = (await res.json().catch(() => ({}))) as {
      data?: unknown;
      error?: string;
      message?: string;
      note?: string;
    };
    if (!res.ok) {
      throw new Error(json.error ?? json.message ?? `${res.status} ${res.statusText}`);
    }
    // File boundary, inbound: persist any client-write directives (files that
    // belong in the caller's project, e.g. recorded flow YAMLs) and rewrite
    // them to the written paths.
    const { result: data } = await applyClientFileDirectives(json.data);
    return { data, note: json.note };
  }

  return { fetchTools, fetchTool, callTool, baseUrl };
}
