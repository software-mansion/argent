import type * as net from "node:net";
import { FAILURE_CODES, FailureError } from "@argent/registry";

/**
 * Frame a newline-delimited JSON socket on the `\n` byte and nothing else.
 *
 * `readline.createInterface` splits on the four ECMAScript line terminators —
 * `\n`, `\r`, U+2028 and U+2029. JSON permits U+2028/U+2029 unescaped inside a
 * string, and the device daemons (NSJSONSerialization, org.json) emit them
 * raw, so a perfectly valid reply carrying one — any accessibility label with a
 * rich-text line separator — was cut into fragments none of which parsed, and
 * its RPC waited out the timeout. A `\n` byte can never occur inside a
 * multi-byte UTF-8 sequence, so splitting on it alone is exact.
 *
 * Every frame that fails to parse is reported through `onDropped` rather than
 * vanishing: a silent drop is what turned a framing defect into a
 * fifteen-second mystery.
 */
interface NdjsonReaderHandlers {
  onMessage: (msg: unknown) => void;
  onDropped: (info: { bytes: number; preview: string }) => void;
}

const PREVIEW_CHARS = 80;

function preview(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const printable = raw.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, "·");
  return printable.length > PREVIEW_CHARS ? `${printable.slice(0, PREVIEW_CHARS)}…` : printable;
}

/**
 * A frame can parse and still nest too deep for `JSON.stringify`, which throws
 * a RangeError on Node 20 to 24, and a throw in a socket handler ends the
 * tool-server.
 */
export function previewJson(value: unknown): string {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(value);
  } catch {
    return "[a value nested too deep to print]";
  }
  return preview(raw ?? String(value));
}

/** The conventional `onDropped`: one stderr line tagged with the owning service. */
export function reportDroppedFrameToStderr(tag: string): NdjsonReaderHandlers["onDropped"] {
  return ({ bytes, preview }) => {
    process.stderr.write(`[${tag}] dropped unparseable frame (${bytes} bytes): ${preview}\n`);
  };
}

/**
 * `maxFrameChars` bounds a frame that has not ended yet. Past it, the frame is
 * reported through `onDropped` and the socket is destroyed: a peer that never
 * sends a `\n` otherwise grows the buffer until the string is too long for V8,
 * and the append throws out of the `data` handler.
 */
export function attachNdjsonReader(
  socket: net.Socket,
  handlers: NdjsonReaderHandlers,
  { maxFrameChars = Infinity }: { maxFrameChars?: number } = {}
): void {
  socket.setEncoding("utf8");
  let buf = "";

  const deliver = (raw: string): void => {
    if (raw.length === 0 || raw === "\r") return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      handlers.onDropped({ bytes: Buffer.byteLength(raw, "utf8"), preview: preview(raw) });
      return;
    }
    handlers.onMessage(msg);
  };

  socket.on("data", (chunk: string | Buffer) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      deliver(raw);
    }
    if (buf.length > maxFrameChars) {
      handlers.onDropped({ bytes: Buffer.byteLength(buf, "utf8"), preview: preview(buf) });
      buf = "";
      socket.destroy();
    }
  });

  // Parity with readline: a final frame without a trailing newline is still
  // delivered when the peer ends the stream.
  socket.on("end", () => {
    const rest = buf;
    buf = "";
    if (rest.length > 0) deliver(rest);
  });
}

function writeNdjsonFrame(socket: net.Socket, frame: unknown): boolean {
  if (socket.destroyed || !socket.writable) return false;
  socket.write(`${JSON.stringify(frame)}\n`);
  return true;
}

const CDP_FRAME_TYPE = "CDP";

const DEFAULT_CDP_TIMEOUT_MS = 10_000;

export interface NdjsonCdpRequester {
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<unknown>;
  handleResponse(payload: unknown): boolean;
  close(): void;
}

export function createNdjsonCdpRequester(
  socket: net.Socket,
  options: { label: string; timeoutMs?: number }
): NdjsonCdpRequester {
  const pending = new Map<
    number,
    {
      method: string;
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let nextId = 1;
  let closed = false;

  const closedError = (method: string): FailureError =>
    new FailureError(`${options.label}: the connection closed before ${method} was answered`, {
      error_code: FAILURE_CODES.NDJSON_CDP_CONNECTION_CLOSED,
      failure_stage: "ndjson_cdp_request",
      failure_area: "tool_server",
      error_kind: "network",
    });

  return {
    request(method, params = {}, { timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS } = {}) {
      if (closed) return Promise.reject(closedError(method));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new FailureError(`${options.label}: ${method} got no reply within ${timeoutMs} ms`, {
              error_code: FAILURE_CODES.NDJSON_CDP_REQUEST_TIMEOUT,
              failure_stage: "ndjson_cdp_request",
              failure_area: "tool_server",
              error_kind: "timeout",
            })
          );
        }, timeoutMs);
        timer.unref();
        pending.set(id, { method, resolve, reject, timer });
        if (!writeNdjsonFrame(socket, { type: CDP_FRAME_TYPE, payload: { id, method, params } })) {
          clearTimeout(timer);
          pending.delete(id);
          reject(closedError(method));
        }
      });
    },

    handleResponse(payload) {
      if (typeof payload !== "object" || payload === null) return false;
      const reply = payload as {
        id?: unknown;
        method?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (typeof reply.id !== "number" || reply.method !== undefined) return false;
      if (!("result" in reply) && !("error" in reply)) return false;
      const entry = pending.get(reply.id);
      if (!entry) return true;
      pending.delete(reply.id);
      clearTimeout(entry.timer);
      if (reply.error !== undefined) {
        const detail = (reply.error as { message?: unknown } | null)?.message;
        const message = typeof detail === "string" ? detail : previewJson(reply.error);
        entry.reject(
          new FailureError(`${options.label}: ${entry.method} failed: ${message}`, {
            error_code: FAILURE_CODES.NDJSON_CDP_REQUEST_FAILED,
            failure_stage: "ndjson_cdp_response",
            failure_area: "tool_server",
            error_kind: "subprocess",
          })
        );
      } else {
        entry.resolve(reply.result);
      }
      return true;
    },

    close() {
      closed = true;
      for (const { method, reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(closedError(method));
      }
      pending.clear();
    },
  };
}
