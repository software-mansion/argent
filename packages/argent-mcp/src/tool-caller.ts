import { createToolsClient, type ToolMeta, type ToolsServerHandle } from "@argent/tools-client";

const MAX_RETRIES = 4;
const EXP_BACKOFF_BASE = 250;
const FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithReconnect(
  getUrl: () => string,
  reconnect: () => Promise<void>,
  config?: {
    /** A function is called once per attempt, so a retry can carry fresh headers. */
    init?: RequestInit | (() => RequestInit);
    expBackoffBase?: number;
    maxRetries?: number;
    fetchTimeoutMs?: number | null;
  }
): Promise<Response> {
  const {
    expBackoffBase = EXP_BACKOFF_BASE,
    maxRetries = MAX_RETRIES,
    fetchTimeoutMs = FETCH_TIMEOUT_MS,
    init,
  } = config ?? {};

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer =
      fetchTimeoutMs !== null ? setTimeout(() => controller.abort(), fetchTimeoutMs) : undefined;
    let callerSignal: AbortSignal | null | undefined;
    try {
      const attemptInit = typeof init === "function" ? init() : init;
      callerSignal = attemptInit?.signal;
      const signal = callerSignal
        ? AbortSignal.any([controller.signal, callerSignal])
        : controller.signal;
      return await fetch(getUrl(), { ...attemptInit, signal });
    } catch (err) {
      lastError = err;
      // The caller stopped waiting, so a retry would only queue work behind
      // the abandoned attempt, which the tool-server keeps running.
      if (callerSignal?.aborted || attempt === maxRetries) break;
      const pause = (async () => {
        if (attempt === 0) {
          // First failure: trigger reconnect (spawns new server if dead)
          await reconnect();
        }
        // Exponential backoff: 250ms, 500ms, 1s, 2s (~3.75s total + reconnect time)
        await new Promise((r) => setTimeout(r, expBackoffBase * Math.pow(2, attempt)));
      })();
      // The caller's signal also ends this pause. A reconnect left behind
      // keeps running for the calls after this one.
      await untilAborted(pause, callerSignal);
      if (callerSignal?.aborted) {
        lastError = callerSignal.reason;
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** Waits for `work`, or only until `signal` fires. Does not stop `work`. */
async function untilAborted(
  work: Promise<unknown>,
  signal: AbortSignal | null | undefined
): Promise<void> {
  if (!signal) {
    await work;
    return;
  }
  let onAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

interface ToolCallerDeps {
  /** The current tool-server handle; the adapter updates it after a respawn. */
  getHandle: () => ToolsServerHandle;
  /**
   * Whether the startup routing named the tool-server (a link or
   * ARGENT_TOOLS_URL). It decides whether file inputs travel with a call, and
   * like the routing it holds until the editor restarts the adapter.
   */
  remote: boolean;
  reconnect: () => Promise<void>;
  /** Headers added to every request, beside the auth header. */
  extraHeaders: () => Record<string, string>;
  /** Per-attempt timeout for a call that is not `longRunning` and carries no upload. */
  fetchTimeoutMs?: number;
}

interface ToolCaller {
  fetchTools(): Promise<ToolMeta[]>;
  /**
   * `opts.signal` bounds the whole call, the listing it reads first included,
   * and is never retried once it fires.
   */
  callTool(
    name: string,
    args: unknown,
    opts?: { signal?: AbortSignal }
  ): Promise<{ result: unknown; outputHint?: string; note?: string; profiling?: boolean }>;
}

// A tool-server URL without `http://` either fails `new URL`, whose error names
// no input, or parses with the host as its scheme (`localhost:3001`), which
// fetch then refuses without naming it. Name the value to fix in both cases.
function parseUrl(url: string): URL {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // Reported below.
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new TypeError(`Failed to parse URL from ${url}: expected an http:// or https:// URL`);
  }
  return parsed;
}

/**
 * The adapter's call path: the tools client's `callTool` (file-input upload,
 * error mapping, client-file directives) wrapped in the adapter's retry loop,
 * per-attempt timeout and frozen routing.
 */
export function createToolCaller(deps: ToolCallerDeps): ToolCaller {
  const timeout = deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;

  // A retry after a local respawn must reach the new server, so each attempt
  // re-reads the handle for the origin and the token.
  function rebase(url: string): string {
    const target = parseUrl(url);
    const current = parseUrl(deps.getHandle().url);
    target.protocol = current.protocol;
    target.host = current.host;
    return target.toString();
  }

  function withHeaders(init: RequestInit): RequestInit {
    const headers = new Headers(init.headers ?? {});
    const { token } = deps.getHandle();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    else headers.delete("Authorization");
    return { ...init, headers };
  }

  const client = createToolsClient({
    baseUrl: async () => ({ ...deps.getHandle(), remote: deps.remote }),
    headers: deps.extraHeaders,
    fetchImpl: async (url, init, meta) => {
      // A retry cannot fix a URL that does not parse, so fail at once.
      parseUrl(url);
      return fetchWithReconnect(() => rebase(url), deps.reconnect, {
        init: () => withHeaders(init),
        // A call that carried an upload is sent once and never aborted: the
        // tool-server consumes the upload when it reads the call, so a second
        // attempt could only fail.
        fetchTimeoutMs: meta.longRunning || meta.carriesUpload ? null : timeout,
        maxRetries: meta.carriesUpload ? 0 : undefined,
      });
    },
  });

  return {
    fetchTools: client.fetchTools,
    async callTool(name, args, opts) {
      const { data, note, outputHint, profiling } = await client.callTool(name, args, opts);
      return { result: data, outputHint, note, ...(profiling ? { profiling } : {}) };
    },
  };
}
