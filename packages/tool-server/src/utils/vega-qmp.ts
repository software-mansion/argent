import net from "node:net";
import { readFile, unlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

/**
 * Minimal QMP (QEMU Machine Protocol) client for the Vega Virtual Device.
 *
 * The VVD is an Android-emulator-derived QEMU that exposes a QMP control socket
 * (a unix socket under /tmp, named for the console port, e.g.
 * `/tmp/qmp-socket-5554.sock`). QMP is newline-delimited JSON: the server emits
 * a greeting, the client sends the one-time `qmp_capabilities` handshake, then
 * issues commands. This QEMU build supports `screendump` (host-side framebuffer
 * capture → PPM) and `send-key` (synthetic key events) — the two primitives
 * Vega screen capture and D-pad input are built on. No auth is required.
 */
export class QmpClient {
  private socket: net.Socket;
  private buffer = "";
  private greeting: Promise<void>;
  private pending: Array<(msg: QmpMessage) => void> = [];

  private constructor(socketPath: string) {
    this.socket = net.connect(socketPath);
    this.socket.setNoDelay(true);
    this.greeting = new Promise<void>((resolve, reject) => {
      const onGreeting = (msg: QmpMessage) => {
        if ("QMP" in msg) resolve();
      };
      this.pending.push(onGreeting);
      this.socket.once("error", reject);
      this.socket.on("data", (chunk) => this.onData(chunk));
    });
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: QmpMessage;
      try {
        msg = JSON.parse(line) as QmpMessage;
      } catch {
        continue;
      }
      // Asynchronous QMP events have an `event` field and no waiter — drop them.
      if ("event" in msg) continue;
      const waiter = this.pending.shift();
      if (waiter) waiter(msg);
    }
  }

  /** Connect, consume the greeting, and complete the capabilities handshake. */
  static async connect(socketPath: string, timeoutMs = 10_000): Promise<QmpClient> {
    const client = new QmpClient(socketPath);
    await withTimeout(client.greeting, timeoutMs, "QMP greeting");
    await client.execute("qmp_capabilities", undefined, timeoutMs);
    return client;
  }

  /** Send one QMP command and resolve with its `return` value (or throw on `error`). */
  execute(command: string, args?: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.push((msg) => {
        if ("error" in msg && msg.error) {
          reject(new Error(`QMP ${command} failed: ${msg.error.desc}`));
        } else {
          resolve((msg as { return?: unknown }).return);
        }
      });
      const payload = args ? { execute: command, arguments: args } : { execute: command };
      this.socket.write(JSON.stringify(payload) + "\n");
    });
    return withTimeout(result, timeoutMs, `QMP ${command}`);
  }

  close(): void {
    this.socket.destroy();
  }
}

interface QmpMessage {
  QMP?: unknown;
  event?: string;
  return?: unknown;
  error?: { class?: string; desc: string };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Locate the running VVD's QMP socket. The socket is named for the console port
 * (`/tmp/qmp-socket-<port>.sock`); v1 targets the single VVD, so we glob and
 * take the first match. Throws a clear error when none exists (no VVD running).
 */
export async function discoverQmpSocket(): Promise<string> {
  const isQmp = (name: string) => name.startsWith("qmp-socket-") && name.endsWith(".sock");
  // The socket lives in the OS temp dir; on macOS `tmpdir()` is /var/folders/…
  // but the VVD writes to the canonical /tmp, so probe both.
  const dirs = Array.from(new Set([tmpdir(), "/tmp"]));
  const matches: string[] = [];
  for (const dir of dirs) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const name of entries) {
      if (isQmp(name)) matches.push(join(dir, name));
    }
  }
  const socket = matches.sort()[0];
  if (!socket) {
    throw new Error(
      "No Vega Virtual Device QMP socket found (looked for /tmp/qmp-socket-*.sock). " +
        "Start the VVD with `vega virtual-device start` and retry."
    );
  }
  return socket;
}

// QMP qcodes for the TV remote, per the VVD's keyboard→remote mapping.
export const REMOTE_QCODES = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  select: "ret",
  back: "esc",
  home: "f1",
  menu: "f2",
  rewind: "f3",
  playPause: "f4",
  fastForward: "f5",
} as const;

export type RemoteButton = keyof typeof REMOTE_QCODES;

/** Press (and release) one remote button via QMP `send-key`. */
export async function sendRemoteKey(socketPath: string, button: RemoteButton): Promise<void> {
  const client = await QmpClient.connect(socketPath);
  try {
    await client.execute("send-key", {
      keys: [{ type: "qcode", data: REMOTE_QCODES[button] }],
    });
  } finally {
    client.close();
  }
}

/** Press (and release) one raw qcode via QMP `send-key` (text-entry helper). */
export async function sendQcode(socketPath: string, qcode: string): Promise<void> {
  const client = await QmpClient.connect(socketPath);
  try {
    await client.execute("send-key", { keys: [{ type: "qcode", data: qcode }] });
  } finally {
    client.close();
  }
}

/**
 * Capture the VVD screen via QMP `screendump` and return the path to a PNG.
 *
 * This QEMU build's `screendump` writes a binary PPM (P6) and does not accept a
 * `format` argument, so we dump to a temp PPM and transcode to PNG with the
 * already-bundled `pngjs`. `scale` (0.01–1.0) nearest-neighbour-downsamples the
 * 1920×1080 framebuffer so the attached image stays small, matching the
 * iOS/Android screenshot tool's server-side scaling.
 */
export async function captureVegaScreenshotPng(opts: { scale?: number } = {}): Promise<string> {
  const socketPath = await discoverQmpSocket();
  const stamp = process.hrtime.bigint().toString();
  const ppmPath = join(tmpdir(), `vega-screenshot-${stamp}.ppm`);
  const pngPath = join(tmpdir(), `vega-screenshot-${stamp}.png`);

  const client = await QmpClient.connect(socketPath);
  try {
    await client.execute("screendump", { filename: ppmPath }, 20_000);
  } finally {
    client.close();
  }

  try {
    const ppm = await readFile(ppmPath);
    const parsed = parsePpm(ppm);
    if (isBlankFrame(parsed.rgb)) {
      throw new VegaScreenshotBlankError();
    }
    const png = rgbToPng(parsed, opts.scale);
    await new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      png
        .pack()
        .on("data", (c: Buffer) => chunks.push(c))
        .on("end", async () => {
          try {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(pngPath, Buffer.concat(chunks));
            resolve();
          } catch (e) {
            reject(e);
          }
        })
        .on("error", reject);
    });
    return pngPath;
  } finally {
    await unlink(ppmPath).catch(() => {});
  }
}

/**
 * Thrown when QMP `screendump` produced a blank (single-colour) frame. On macOS
 * the VVD renders through host GPU acceleration that `screendump` cannot read
 * (it captures the empty QEMU console), and the on-device `gwsi-tool-
 * screenshooter` segfaults on the virtual device — so VVD screen capture is not
 * available there. The message is actionable: it points at a physical device or
 * a Linux `--no-gl-accel` VVD, and notes the working alternatives.
 */
export class VegaScreenshotBlankError extends Error {
  constructor() {
    super(
      "Vega Virtual Device screen capture returned a blank frame. The VVD renders " +
        "through host GPU acceleration that QMP screendump cannot read on macOS, and " +
        "the on-device gwsi-tool-screenshooter is not functional on the virtual device. " +
        "Screenshots of Vega currently require a physical Fire TV (or a Linux VVD started " +
        "with --no-gl-accel). You can still drive the VVD with the `remote` tool and, when " +
        "Metro is reachable, inspect it with the debugger tools."
    );
    this.name = "VegaScreenshotBlankError";
  }
}

/**
 * Heuristic: a frame is "blank" if a stride-sampled set of pixels are all the
 * same colour. Cheap (samples ~every 997th pixel, a prime stride to avoid
 * aliasing with row width) and good enough to distinguish the all-black GL
 * surface from real content.
 */
function isBlankFrame(rgb: Buffer): boolean {
  if (rgb.length < 3) return true;
  const r0 = rgb[0]!;
  const g0 = rgb[1]!;
  const b0 = rgb[2]!;
  for (let i = 0; i + 2 < rgb.length; i += 997 * 3) {
    if (rgb[i] !== r0 || rgb[i + 1] !== g0 || rgb[i + 2] !== b0) return false;
  }
  return true;
}

/** Parse a binary PPM (P6) into { width, height, rgb }. */
function parsePpm(buf: Buffer): { width: number; height: number; rgb: Buffer } {
  if (buf[0] !== 0x50 || buf[1] !== 0x36) {
    throw new Error("screendump did not produce a P6 PPM");
  }
  // Read three ASCII integers (width, height, maxval) after the magic, skipping
  // whitespace and `#` comment lines, then the pixel data starts after a single
  // whitespace byte.
  let pos = 2;
  const ints: number[] = [];
  while (ints.length < 3) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]!))) pos++;
    if (buf[pos] === 0x23) {
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
      continue;
    }
    let num = "";
    while (pos < buf.length && /[0-9]/.test(String.fromCharCode(buf[pos]!))) {
      num += String.fromCharCode(buf[pos]!);
      pos++;
    }
    ints.push(parseInt(num, 10));
  }
  pos++; // single whitespace after maxval
  const [width, height] = ints as [number, number, number];
  return { width, height, rgb: buf.subarray(pos, pos + width * height * 3) };
}

/** RGB framebuffer → pngjs PNG, nearest-neighbour downsampled by `scale` (default 0.3). */
function rgbToPng(
  { width, height, rgb }: { width: number; height: number; rgb: Buffer },
  scale = Number(process.env.ARGENT_SCREENSHOT_SCALE) || 0.3
): PNG {
  const s = Math.min(Math.max(scale, 0.01), 1.0);
  const outW = Math.max(1, Math.round(width * s));
  const outH = Math.max(1, Math.round(height * s));
  const png = new PNG({ width: outW, height: outH });
  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(height - 1, Math.floor(y / s));
    for (let x = 0; x < outW; x++) {
      const srcX = Math.min(width - 1, Math.floor(x / s));
      const si = (srcY * width + srcX) * 3;
      const di = (y * outW + x) * 4;
      png.data[di] = rgb[si] ?? 0;
      png.data[di + 1] = rgb[si + 1] ?? 0;
      png.data[di + 2] = rgb[si + 2] ?? 0;
      png.data[di + 3] = 255;
    }
  }
  return png;
}
