import * as http from "node:http";

/**
 * Keep-alive HTTP/1.1 client for the on-device Vega agent.
 *
 * The agent listens on a device-local port reached from the host through a
 * single `adb forward`. A keep-alive socket (maxSockets: 1) holds the connection
 * open and naturally serializes requests — matching the agent's single inputd
 * REPL and keeping per-op cost to a localhost round-trip (~1ms).
 *
 * Logical command failures come back as HTTP 200 with `{ok:false, error}` (the
 * same envelope convention as android-devtools-client); non-2xx is reserved for
 * transport faults.
 */

/**
 * A transport-level failure talking to the agent (non-2xx, timeout, dropped
 * socket, non-JSON body) — i.e. the agent is unreachable or unhealthy, as
 * opposed to a logical command error (HTTP 200 `{ok:false}`), which surfaces as
 * a plain `Error`. The transport restarts the agent only for *this* class, so a
 * bad command fails fast instead of forcing a needless redeploy/restart.
 */
export class VegaAgentTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VegaAgentTransportError";
  }
}

export interface VegaAgentPing {
  ok: boolean;
  version: string;
  protocol: string;
}

export interface VegaAgentClient {
  readonly hostPort: number;
  ping(timeoutMs?: number): Promise<VegaAgentPing>;
  cmd<T = unknown>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  shutdown(timeoutMs?: number): Promise<void>;
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const LONG_TIMEOUT_MS = 15_000; // getPageSource can be multi-KB

interface AgentEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { type?: string; message?: string };
  version?: string;
  protocol?: string;
}

export function createVegaAgentClient(hostPort: number): VegaAgentClient {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  // Serialize requests on one socket — the device-side REPL is single-threaded.
  let chain: Promise<unknown> = Promise.resolve();

  function rawRequest<T>(
    method: "GET" | "POST",
    pathname: string,
    body: string | null,
    timeoutMs: number
  ): Promise<AgentEnvelope<T>> {
    return new Promise<AgentEnvelope<T>>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: hostPort,
          method,
          path: pathname,
          agent,
          headers:
            body != null
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
              : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(
                new VegaAgentTransportError(
                  `vega-agent ${pathname} HTTP ${res.statusCode}: ${text.slice(0, 200)}`
                )
              );
              return;
            }
            try {
              resolve(JSON.parse(text) as AgentEnvelope<T>);
            } catch {
              reject(
                new VegaAgentTransportError(
                  `vega-agent ${pathname} returned non-JSON: ${text.slice(0, 200)}`
                )
              );
            }
          });
        }
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new VegaAgentTransportError(`vega-agent ${pathname} timed out after ${timeoutMs}ms`));
      });
      req.on("error", (err) =>
        reject(new VegaAgentTransportError(`vega-agent ${pathname} socket error: ${err.message}`))
      );
      if (body != null) req.write(body);
      req.end();
    });
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(fn, fn);
    chain = result.catch(() => undefined);
    return result;
  }

  return {
    hostPort,

    ping(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<VegaAgentPing> {
      return enqueue(async () => {
        const env = await rawRequest<unknown>("GET", "/ping", null, timeoutMs);
        return {
          ok: Boolean(env.ok),
          version: env.version ?? "",
          protocol: env.protocol ?? "",
        };
      });
    },

    cmd<T>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
      const effectiveTimeout = timeoutMs ?? (op === "getPageSource" ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
      return enqueue(async () => {
        const env = await rawRequest<T>("POST", "/cmd", JSON.stringify({ op, args }), effectiveTimeout);
        if (!env.ok) {
          const type = env.error?.type ?? "AgentError";
          const message = env.error?.message ?? "unknown agent error";
          throw new Error(`${type}: ${message}`);
        }
        return env.result as T;
      });
    },

    shutdown(timeoutMs = 1_000): Promise<void> {
      return enqueue(async () => {
        try {
          await rawRequest<unknown>("POST", "/shutdown", "{}", timeoutMs);
        } catch {
          /* best-effort — the agent exits as soon as it flushes the reply */
        }
      });
    },

    close(): void {
      agent.destroy();
    },
  };
}
