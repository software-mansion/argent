import { promises as fs } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import type { MjpegStream } from "./mjpeg-stream";

export interface DebugCapture {
  frameTimesUs: number[];
  warning: string | null;
  attach(stream: MjpegStream): void;
  finish(): Promise<void>;
  cleanup(): Promise<void>;
}

const MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
const WRITE_CONCURRENCY = 4;

export function startDebugCapture(
  stdin: Writable,
  directory: string,
  ended: () => void
): DebugCapture {
  const startedAtMs = performance.now();
  let unsubscribe: (() => void) | null = null;
  let finishing: Promise<void> | null = null;
  const writes = Array.from({ length: WRITE_CONCURRENCY }, () => Promise.resolve());
  let queuedBytes = 0;
  let writeError: Error | null = null;
  const files: string[] = [];
  const capture: DebugCapture = {
    frameTimesUs: [],
    warning: null,
    attach(stream) {
      if (finishing) return;
      unsubscribe?.();
      unsubscribe = stream.subscribe((frame, parsedAtMs) => {
        if (finishing) return;
        if (queuedBytes + frame.length > MAX_BUFFERED_BYTES) {
          capture.warning =
            "Debug capture ended because JPEG writes could not keep up with the frame stream. Subsequent frames were not recorded.";
          void capture.finish();
          ended();
          return;
        }
        const parsedAtUs = Math.max(0, Math.round((parsedAtMs - startedAtMs) * 1_000));
        const previous = capture.frameTimesUs.at(-1);
        const ptsUs = previous !== undefined ? Math.max(parsedAtUs, previous + 1) : 0;
        const index = capture.frameTimesUs.length;
        const file = path.join(directory, `${index}.jpg`);
        const lane = index % WRITE_CONCURRENCY;
        capture.frameTimesUs.push(ptsUs);
        queuedBytes += frame.length;
        writes[lane] = writes[lane].then(async () => {
          try {
            if (writeError) return;
            await fs.writeFile(file, frame);
            files[index] = file;
          } catch (err) {
            writeError = err instanceof Error ? err : new Error(String(err));
            capture.warning = `Debug capture ended because a JPEG could not be saved: ${writeError.message}. Subsequent frames were not recorded.`;
            void capture.finish();
            ended();
          } finally {
            queuedBytes -= frame.length;
          }
        });
      });
    },
    finish() {
      if (finishing) return finishing;
      unsubscribe?.();
      unsubscribe = null;
      const parsedAtUs = Math.round((performance.now() - startedAtMs) * 1_000);
      finishing = (async () => {
        await Promise.all(writes);
        const missing = files.findIndex((file) => file === undefined);
        if (missing !== -1) files.splice(missing);
        capture.frameTimesUs.splice(files.length);
        if (files.length > 0) {
          const ptsUs = Math.max(parsedAtUs, capture.frameTimesUs.at(-1)! + 1);
          capture.frameTimesUs.push(ptsUs);
          files.push(files.at(-1)!);
        }
        const entries = files.map((file, i) => {
          const durationUs =
            i + 1 < files.length ? capture.frameTimesUs[i + 1] - capture.frameTimesUs[i] : 1;
          // Concat's lexer uses shell-style quoting, even on Windows.
          const normalized = process.platform === "win32" ? file.replace(/\\/g, "/") : file;
          const quoted = normalized.replace(/'/g, "'\\''");
          return `file 'file:${quoted}'\noption framerate 1000000\nduration ${(durationUs / 1_000_000).toFixed(6)}\n`;
        });
        if (stdin.writable) stdin.end(`ffconcat version 1.0\n${entries.join("")}`);
      })();
      return finishing;
    },
    async cleanup() {
      await capture.finish();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
  return capture;
}
