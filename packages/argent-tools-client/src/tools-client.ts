import { realpath } from "node:fs/promises";
import * as path from "node:path";

import {
  CLIENT_REQUEST_EVENT,
  CLIENT_SERVICES_VERSION,
  type ClientRequestLine,
  type ClientServicesAdvert,
} from "@argent/registry";

import { ensureToolsServer, type ToolsServerHandle, type ToolsServerPaths } from "./launcher.js";
import { getResolvedToolsUrl } from "./link-config.js";
import { prepareFileInputs, applyClientFileDirectives, type FileInputSpec } from "./file-inputs.js";
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
   * Override the resolution of the tool-server URL and token. The MCP adapter
   * freezes routing at startup and updates the handle after a local respawn.
   * When set, the client never reads the link config for routing and never
   * spawns. The remote/co-located decision for file inputs still comes from
   * `getResolvedToolsUrl()`.
   */
  baseUrl?: () => Promise<ToolsServerHandle>;
  /**
   * Override the fetch used for GET /tools and POST /tools/:name, so a caller
   * can wrap retries and a per-attempt timeout around each request.
   * `meta.longRunning` is the tool's flag from the listing (false for GET
   * /tools), so the caller can disable its timeout. POST /upload and the
   * client-services answer POSTs keep the global fetch.
   */
  fetchImpl?: (url: string, init: RequestInit, meta: { longRunning: boolean }) => Promise<Response>;
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

/** How a stream's `client-request` lines are answered: the handler and where to post. */
interface ClientServicesLink {
  handler: ClientServicesHandler;
  answerUrl: (invocation: string) => string;
  headers: Record<string, string>;
}

/**
 * Answer one request line and post the answer. Never rejects: a failed post is
 * one stderr line, and the server times the request out on its side.
 */
async function answerClientRequest(
  link: ClientServicesLink,
  msg: ClientRequestLine
): Promise<void> {
  const body = await link.handler.handle(msg);
  const describe = `answer to ${String(msg.op)} request ${String(msg.id)} failed`;
  try {
    const res = await fetch(link.answerUrl(String(msg.invocation)), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...link.headers },
      body: JSON.stringify(body),
    });
    // Drain so the connection is released; the body itself is not needed.
    await res.text().catch(() => undefined);
    if (!res.ok) {
      process.stderr.write(`[client-services] ${describe}: ${res.status} ${res.statusText}\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[client-services] ${describe}: ${message}\n`);
  }
}

/** Read an NDJSON tool-invocation stream, mirroring the buffered path's contract. */
async function consumeToolStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (event: unknown) => void,
  services?: ClientServicesLink
): Promise<ToolInvocationResult> {
  let final: { data?: unknown; note?: string } | undefined;
  // Answers are posted while the stream keeps flowing; they are awaited once
  // the read loop ends so none is left dangling, on success or on error.
  const answers: Promise<void>[] = [];
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
    else if (msg.event === CLIENT_REQUEST_EVENT) {
      // Without a handler the line is ignored, as any unknown event is.
      if (services) answers.push(answerClientRequest(services, msg as ClientRequestLine));
    } else if (msg.event === "result") final = { data: msg.data, note: msg.note };
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
    await Promise.all(answers);
    throw err;
  }
  await Promise.all(answers);

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
 * The handler for one call, or null when the arguments carry no string
 * `project_root` (nothing to serve under) or nothing under the roots exists.
 * The roots are the project, its `.argent/flows` directory (a project may keep
 * that one as a symlink to a tree outside the project, and the flows there
 * are still the project's own), the directory of `flow_path` when given, so a
 * flow addressed outside the project can still reach its own fragments, and
 * the directory the root flow file REALLY lives in: a `run:` target resolves
 * beside the real file, as it does on one computer, so a root flow that is a
 * symlink serves the fragments next to its target. Every root is served by
 * its real location; one that does not exist is dropped.
 */
async function clientServicesHandlerFor(
  advert: ClientServicesAdvert,
  args: unknown
): Promise<ClientServicesHandler | null> {
  if (typeof args !== "object" || args === null) return null;
  const { project_root, flow_path, name } = args as Record<string, unknown>;
  if (typeof project_root !== "string") return null;
  const flowsDir = path.join(project_root, ".argent", "flows");
  const roots = [project_root, flowsDir];
  const rootFlow =
    typeof flow_path === "string"
      ? flow_path
      : typeof name === "string"
        ? path.join(flowsDir, `${name}.yaml`)
        : undefined;
  if (rootFlow !== undefined) {
    roots.push(path.dirname(rootFlow));
    const real = await realpath(rootFlow).catch(() => null);
    if (real !== null) roots.push(path.dirname(real));
  }
  return createClientServicesHandler({ roots, advertised: advert.ops });
}

export function createToolsClient(options: CreateToolsClientOptions = {}): ToolsClient {
  let cached: ToolsServerHandle | null = null;
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));

  async function baseUrl(): Promise<ToolsServerHandle> {
    if (options.baseUrl) return options.baseUrl();
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
    const res = await doFetch(
      `${url}/tools`,
      { headers: authHeaders(token) },
      { longRunning: false }
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
    const { url, token } = await baseUrl();

    // File boundary, outbound: wrap args the tool declares as file paths so the
    // server can read them in place (co-located) or from inlined content (remote).
    // Client services, outbound: offer to serve project files during the call
    // when the tool can ask for them and the server is remote.
    let finalArgs = args;
    let services: ClientServicesLink | undefined;
    const meta = await fetchTool(name);
    if (meta?.fileInputs?.length || meta?.clientServices) {
      const { url: routedUrl } = await getResolvedToolsUrl();
      const isRemote = routedUrl !== null;
      if (meta.fileInputs?.length) {
        finalArgs = await prepareFileInputs(meta.fileInputs, args ?? {}, {
          includeContent: isRemote,
          uploadEndpoint: isRemote ? { url, token } : undefined,
        });
      }
      if (isRemote && meta.clientServices?.version === CLIENT_SERVICES_VERSION) {
        const handler = await clientServicesHandlerFor(meta.clientServices, args);
        if (handler) {
          finalArgs = { ...(finalArgs as Record<string, unknown>), client_services: handler.param };
          services = {
            handler,
            answerUrl: (invocation) =>
              `${url}/invocations/${encodeURIComponent(invocation)}/client-responses`,
            headers: authHeaders(token),
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
          ...(stream ? { Accept: "application/x-ndjson" } : {}),
          ...authHeaders(token),
        },
        body: JSON.stringify(finalArgs ?? {}),
      },
      { longRunning: meta?.longRunning === true }
    );
    // The server commits to streaming only after every pre-invoke gate passes —
    // validation errors stay plain JSON with their status codes — so Content-Type
    // is the authoritative mode signal.
    const contentType = res.headers.get("content-type") ?? "";
    if (stream && res.ok && res.body && contentType.includes("application/x-ndjson")) {
      const streamed = await consumeToolStream(res.body, opts?.onProgress ?? (() => {}), services);
      return { ...streamed, outputHint: meta?.outputHint };
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
    return { data, note: json.note, outputHint: meta?.outputHint };
  }

  return { fetchTools, fetchTool, callTool, baseUrl };
}
