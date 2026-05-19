import * as net from "node:net";
import * as readline from "node:readline";

/**
 * Newline-delimited JSON socket client for the android-devtools helper.
 *
 * UiAutomation is single-threaded inside the helper, so requests are
 * serialised here too — every `request` waits for the previous response
 * before sending. The 5 s per-RPC timeout matches the iOS native-devtools
 * client (`packages/tool-server/src/blueprints/native-devtools.ts:299`).
 */

export interface AndroidDevtoolsClient {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const LONG_RPC_TIMEOUT_MS = 15_000;

/**
 * Connect to the helper over a forwarded TCP socket and return a typed RPC
 * client. The socket's `close` / `error` events fire onTerminated so the
 * caller can propagate them to the registry's `terminated` event.
 */
export function connectAndroidDevtoolsClient(
  localPort: number,
  onTerminated: (error?: Error) => void
): Promise<AndroidDevtoolsClient> {
  return new Promise<AndroidDevtoolsClient>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: localPort });
    socket.setNoDelay(true);

    const pending = new Map<number, PendingRequest>();
    let nextId = 1;
    let closed = false;
    // Serial request queue: only one request is in flight at a time. This
    // matches the helper's single UiAutomation worker thread — sending two
    // concurrent requests would still be serialised on the device, but the
    // host-side queue makes timeouts predictable.
    let chain: Promise<unknown> = Promise.resolve();

    const cleanup = (error?: Error) => {
      if (closed) return;
      closed = true;
      for (const req of pending.values()) {
        clearTimeout(req.timer);
        req.reject(error ?? new Error("AndroidDevtools client closed"));
      }
      pending.clear();
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      onTerminated(error);
    };

    socket.once("connect", () => {
      const rl = readline.createInterface({ input: socket });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let parsed: { id?: number; result?: unknown; error?: { message?: string; type?: string } };
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof parsed.id !== "number") return;
        const req = pending.get(parsed.id);
        if (!req) return;
        pending.delete(parsed.id);
        clearTimeout(req.timer);
        if (parsed.error) {
          const message = parsed.error.message ?? "Unknown helper error";
          const type = parsed.error.type ?? "HelperError";
          req.reject(new Error(`${type}: ${message}`));
        } else {
          req.resolve(parsed.result);
        }
      });
      rl.on("close", () => cleanup());

      resolve({
        request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
          const send = (): Promise<T> => {
            if (closed) return Promise.reject(new Error("AndroidDevtools client closed"));
            const id = nextId++;
            const timeoutMs = method === "getHierarchy" ? LONG_RPC_TIMEOUT_MS : DEFAULT_RPC_TIMEOUT_MS;
            return new Promise<T>((resolveReq, rejectReq) => {
              const timer = setTimeout(() => {
                pending.delete(id);
                rejectReq(new Error(`AndroidDevtools RPC ${method} timed out after ${timeoutMs}ms`));
              }, timeoutMs);
              pending.set(id, {
                resolve: (v) => resolveReq(v as T),
                reject: rejectReq,
                timer,
              });
              try {
                socket.write(JSON.stringify({ id, method, params }) + "\n");
              } catch (err) {
                clearTimeout(timer);
                pending.delete(id);
                rejectReq(err instanceof Error ? err : new Error(String(err)));
              }
            });
          };
          // Chain so requests serialise; swallow rejection on the chain
          // pointer so one failure doesn't poison subsequent requests.
          const result = chain.then(send, send);
          chain = result.catch(() => undefined);
          return result;
        },
        close() {
          cleanup();
        },
      });
    });

    socket.once("error", (err) => {
      if (!closed) {
        cleanup(err);
        reject(err);
      }
    });

    socket.once("close", () => {
      if (!closed) cleanup(new Error("AndroidDevtools socket closed unexpectedly"));
    });
  });
}
