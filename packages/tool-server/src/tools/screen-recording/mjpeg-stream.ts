import http from "http";
import { FAILURE_CODES, FailureError } from "@argent/registry";

/**
 * Client for simulator-server's `/stream.mjpeg` endpoint — the same live frame
 * stream the preview UI renders. The server is a `multipart/x-mixed-replace`
 * producer that emits a JPEG whenever the device screen CHANGES (a still
 * screen produces no frames at all), so this client only tracks the most
 * recent frame; turning that into an even-cadence video is the pump's job in
 * `capture.ts`.
 *
 * Multiple clients are supported by the server (it refcounts subscribers onto
 * one shared encoder), so recording does not disturb a preview window that is
 * already streaming the same device.
 */

/** Frames arrive fast and large; refuse to grow the reassembly buffer forever. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface MjpegStream {
  /** Most recent complete JPEG frame, or null until the first one lands. */
  readonly latest: Buffer | null;
  /** Frames seen since connect — diagnostics for "the device never drew". */
  readonly frameCount: number;
  /** Set when the connection dropped mid-recording. */
  readonly error: Error | null;
  /** Resolves with the first frame, or rejects when none arrives in time. */
  waitForFirstFrame(timeoutMs: number): Promise<Buffer>;
  close(): void;
}

/** `multipart/x-mixed-replace;boundary=NextFrame` -> `--NextFrame`. */
function delimiterFromContentType(contentType: string | undefined): Buffer {
  const match = /boundary=([^;\s]+)/i.exec(contentType ?? "");
  const boundary = match?.[1]?.replace(/^"|"$/g, "") ?? "NextFrame";
  return Buffer.from(`--${boundary}`);
}

function streamFailure(
  message: string,
  stage: string,
  kind: "network" | "timeout" = "network",
  cause?: unknown
): FailureError {
  return new FailureError(
    message,
    {
      error_code: FAILURE_CODES.SCREEN_RECORDING_STREAM_UNAVAILABLE,
      failure_stage: stage,
      failure_area: "tool_server",
      error_kind: kind,
      failure_command: "simulator_server",
    },
    cause instanceof Error ? { cause } : undefined
  );
}

/**
 * Connect to an MJPEG endpoint and start collecting frames. Resolves as soon as
 * the response headers are in (frames may still be pending — use
 * `waitForFirstFrame` for that).
 */
export function openMjpegStream(url: string, connectTimeoutMs = 10_000): Promise<MjpegStream> {
  return new Promise<MjpegStream>((resolve, reject) => {
    let settled = false;
    const request = http.get(url, (res) => {
      // The timeout armed below is an INACTIVITY timeout, not a connect-only
      // one. A still screen produces no frames — and therefore no bytes — so
      // leaving it armed would tear the stream down mid-recording exactly when
      // nothing is happening on screen. The connection is up now, so disarm it.
      request.setTimeout(0);
      res.socket?.setTimeout(0);
      if (res.statusCode !== 200) {
        res.resume();
        settled = true;
        reject(
          streamFailure(
            `simulator-server's frame stream returned HTTP ${res.statusCode ?? "?"} at ${url}.`,
            "screen_recording_stream_connect"
          )
        );
        return;
      }

      const delimiter = delimiterFromContentType(res.headers["content-type"]);
      // `subarray` narrows to ArrayBufferLike, so the accumulator is declared
      // that way rather than as the ArrayBuffer-backed default.
      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const state = {
        latest: null as Buffer | null,
        frameCount: 0,
        error: null as Error | null,
      };
      let firstFrameResolve: ((frame: Buffer) => void) | null = null;
      let firstFrameReject: ((err: Error) => void) | null = null;

      res.on("data", (chunk: Buffer) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        for (;;) {
          const partStart = buffer.indexOf(delimiter);
          if (partStart < 0) break;
          // Part headers run to the blank line; the JPEG payload starts after it.
          const headerEnd = buffer.indexOf("\r\n\r\n", partStart);
          if (headerEnd < 0) break;
          const frameStart = headerEnd + 4;
          // The server writes the next delimiter directly after the JPEG's last
          // byte (no trailing CRLF), so the frame is everything up to it. Until
          // that delimiter lands the frame is still incomplete.
          const frameEnd = buffer.indexOf(delimiter, frameStart);
          if (frameEnd < 0) break;
          if (frameEnd > frameStart) {
            // Copy out of the reassembly buffer: a subarray would pin the whole
            // (multi-megabyte) chunk alive for as long as we hold the frame.
            const frame = Buffer.from(buffer.subarray(frameStart, frameEnd));
            state.latest = frame;
            state.frameCount++;
            if (firstFrameResolve) {
              firstFrameResolve(frame);
              firstFrameResolve = null;
              firstFrameReject = null;
            }
          }
          buffer = buffer.subarray(frameEnd);
        }
        // A stream that never yields a delimiter (wrong endpoint, proxy that
        // rewrites the body) must not grow the heap without bound.
        if (buffer.length > MAX_BUFFER_BYTES) buffer = Buffer.alloc(0);
      });

      const fail = (err: Error) => {
        state.error = err;
        // A drop while the first frame is still pending must reject that waiter
        // now — otherwise it blocks the full first-frame timeout and then throws
        // a misleading "no frame arrived" message that masks the real cause.
        if (firstFrameReject) {
          const reject = firstFrameReject;
          firstFrameResolve = null;
          firstFrameReject = null;
          reject(
            streamFailure(
              `simulator-server's frame stream dropped before the first frame arrived: ${err.message}`,
              "screen_recording_stream_first_frame",
              "network",
              err
            )
          );
        }
      };
      res.on("error", fail);
      res.on("aborted", () => fail(new Error("frame stream aborted")));

      settled = true;
      resolve({
        get latest() {
          return state.latest;
        },
        get frameCount() {
          return state.frameCount;
        },
        get error() {
          return state.error;
        },
        waitForFirstFrame(timeoutMs: number) {
          if (state.latest) return Promise.resolve(state.latest);
          // The stream already dropped before any frame — fail now rather than
          // wait out the whole timeout for a frame that can never arrive.
          if (state.error) {
            return Promise.reject(
              streamFailure(
                `simulator-server's frame stream dropped before any frame arrived: ${state.error.message}`,
                "screen_recording_stream_first_frame",
                "network",
                state.error
              )
            );
          }
          return new Promise<Buffer>((resolveFrame, rejectFrame) => {
            const timer = setTimeout(() => {
              firstFrameResolve = null;
              firstFrameReject = null;
              rejectFrame(
                streamFailure(
                  `No frame arrived from simulator-server within ${timeoutMs} ms. ` +
                    `Is the device booted and its screen on?`,
                  "screen_recording_stream_first_frame",
                  "timeout"
                )
              );
            }, timeoutMs);
            firstFrameResolve = (frame) => {
              clearTimeout(timer);
              firstFrameReject = null;
              resolveFrame(frame);
            };
            firstFrameReject = (err) => {
              clearTimeout(timer);
              firstFrameResolve = null;
              rejectFrame(err);
            };
          });
        },
        close() {
          // Drop the waiter hooks before destroying the socket so the resulting
          // 'aborted'/'error' from our own teardown does not reject a caller
          // that has already moved on.
          firstFrameResolve = null;
          firstFrameReject = null;
          res.destroy();
          request.destroy();
        },
      });
    });

    request.setTimeout(connectTimeoutMs, () => {
      request.destroy(
        streamFailure(
          `Connecting to simulator-server's frame stream at ${url} timed out after ${connectTimeoutMs} ms.`,
          "screen_recording_stream_connect",
          "timeout"
        )
      );
    });

    request.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(
        err instanceof FailureError
          ? err
          : streamFailure(
              `Could not open simulator-server's frame stream at ${url}: ${err.message}`,
              "screen_recording_stream_connect",
              "network",
              err
            )
      );
    });
  });
}

/**
 * Frame size straight from the JPEG's SOF marker, so the watermark geometry
 * needs no ffprobe pass over a file that does not exist yet.
 */
export function readJpegDimensions(jpeg: Buffer): { width: number; height: number } | null {
  // Skip the SOI (0xFFD8) and walk the marker segments.
  let offset = 2;
  while (offset + 9 < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = jpeg[offset + 1]!;
    // 0xFF may repeat as fill bytes before the actual marker (T.81 B.1.1.2):
    // advance one byte so the next iteration reads the real marker instead of
    // treating the fill pair as a segment length and jumping into garbage.
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // SOF0/1/2 (baseline/extended/progressive) hold the frame dimensions.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = jpeg.readUInt16BE(offset + 5);
      const width = jpeg.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    const segmentLength = jpeg.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}
