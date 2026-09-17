import type * as net from "node:net";

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

/** The conventional `onDropped`: one stderr line tagged with the owning service. */
export function reportDroppedFrameToStderr(tag: string): NdjsonReaderHandlers["onDropped"] {
  return ({ bytes, preview }) => {
    process.stderr.write(`[${tag}] dropped unparseable frame (${bytes} bytes): ${preview}\n`);
  };
}

export function attachNdjsonReader(socket: net.Socket, handlers: NdjsonReaderHandlers): void {
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
  });

  // Parity with readline: a final frame without a trailing newline is still
  // delivered when the peer ends the stream.
  socket.on("end", () => {
    const rest = buf;
    buf = "";
    if (rest.length > 0) deliver(rest);
  });
}
