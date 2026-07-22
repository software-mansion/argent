import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { getFailureSignal, FAILURE_CODES } from "@argent/registry";
import { openMjpegStream, type MjpegStream } from "../src/tools/screen-recording/mjpeg-stream";

/**
 * These run against a real local HTTP server that reproduces simulator-server's
 * framing exactly — including the quirk that the boundary follows the JPEG's
 * last byte with no CRLF in between, which is what stops off-the-shelf
 * multipart demuxers from reading this stream.
 */

const BOUNDARY = "--NextFrame\r\nContent-Type:image/jpeg\r\n\r\n";

function jpeg(marker: number, size = 32): Buffer {
  const buf = Buffer.alloc(size, marker);
  buf.writeUInt16BE(0xffd8, 0);
  buf.writeUInt16BE(0xffd9, size - 2);
  return buf;
}

let server: http.Server | null = null;
let stream: MjpegStream | null = null;

afterEach(async () => {
  stream?.close();
  stream = null;
  if (server) {
    const s = server;
    server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** Serve a scripted sequence of raw chunks; returns the stream URL. */
async function serveChunks(
  write: (res: http.ServerResponse) => void,
  status = 200,
  contentType = "multipart/x-mixed-replace;boundary=NextFrame"
): Promise<string> {
  server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": contentType });
    write(res);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}/stream.mjpeg`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("openMjpegStream", () => {
  it("extracts frames delimited the way simulator-server writes them", async () => {
    const first = jpeg(0xa1);
    const second = jpeg(0xb2);
    const url = await serveChunks((res) => {
      res.write(Buffer.concat([Buffer.from(BOUNDARY), first, Buffer.from(BOUNDARY)]));
      // Delayed so the two frames land in separate reads: the point of the test
      // is that each one is decoded, and that `latest` tracks the newest.
      setTimeout(() => res.write(Buffer.concat([second, Buffer.from(BOUNDARY)])), 25);
    });

    stream = await openMjpegStream(url);
    const frame = await stream.waitForFirstFrame(2_000);
    expect(frame.equals(first)).toBe(true);

    await waitFor(() => stream!.frameCount >= 2);
    expect(stream.latest!.equals(second)).toBe(true);
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    const frame = jpeg(0xc3, 64);
    const url = await serveChunks((res) => {
      res.write(Buffer.concat([Buffer.from(BOUNDARY), frame.subarray(0, 20)]));
      setTimeout(() => res.write(frame.subarray(20)), 15);
      setTimeout(() => res.write(Buffer.from(BOUNDARY)), 30);
    });

    stream = await openMjpegStream(url);
    const received = await stream.waitForFirstFrame(2_000);
    expect(received.equals(frame)).toBe(true);
  });

  it("holds an incomplete trailing frame back until its delimiter arrives", async () => {
    const url = await serveChunks((res) => {
      res.write(Buffer.concat([Buffer.from(BOUNDARY), jpeg(0xd4)]));
    });

    stream = await openMjpegStream(url);
    await expect(stream.waitForFirstFrame(150)).rejects.toThrow(/No frame arrived/);
    expect(stream.frameCount).toBe(0);
  });

  it("honours the boundary declared in the content-type header", async () => {
    const frame = jpeg(0xe5);
    const custom = "--OtherBoundary\r\nContent-Type:image/jpeg\r\n\r\n";
    const url = await serveChunks(
      (res) => {
        res.write(Buffer.concat([Buffer.from(custom), frame, Buffer.from(custom)]));
      },
      200,
      "multipart/x-mixed-replace;boundary=OtherBoundary"
    );

    stream = await openMjpegStream(url);
    expect((await stream.waitForFirstFrame(2_000)).equals(frame)).toBe(true);
  });

  it("fails with a stream-unavailable signal on a non-200 response", async () => {
    const url = await serveChunks((res) => res.end("nope"), 503, "text/plain");

    try {
      stream = await openMjpegStream(url);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.SCREEN_RECORDING_STREAM_UNAVAILABLE
      );
      expect((err as Error).message).toContain("503");
    }
  });

  it("fails with a stream-unavailable signal when nothing is listening", async () => {
    try {
      // Port 1 on loopback refuses immediately.
      stream = await openMjpegStream("http://127.0.0.1:1/stream.mjpeg");
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.SCREEN_RECORDING_STREAM_UNAVAILABLE
      );
    }
  });

  it("survives a silent stretch longer than the connect timeout", async () => {
    // A still screen emits no frames and therefore no bytes. The connect
    // timeout must not double as an inactivity timeout, or recording a static
    // screen would tear the stream down mid-capture.
    const late = jpeg(0xa7);
    const url = await serveChunks((res) => {
      res.write(Buffer.concat([Buffer.from(BOUNDARY), jpeg(0x11), Buffer.from(BOUNDARY)]));
      setTimeout(() => res.write(Buffer.concat([late, Buffer.from(BOUNDARY)])), 500);
    });

    stream = await openMjpegStream(url, 200);
    await stream.waitForFirstFrame(1_000);

    await waitFor(() => stream!.frameCount >= 2, 3_000);
    expect(stream.error).toBeNull();
    expect(stream.latest!.equals(late)).toBe(true);
  });

  it("records a mid-stream disconnect so stop can warn about it", async () => {
    const url = await serveChunks((res) => {
      res.write(Buffer.concat([Buffer.from(BOUNDARY), jpeg(0xf6), Buffer.from(BOUNDARY)]));
      setTimeout(() => res.destroy(), 20);
    });

    stream = await openMjpegStream(url);
    await stream.waitForFirstFrame(2_000);
    await waitFor(() => stream!.error !== null);
    expect(stream.error).toBeInstanceOf(Error);
  });
});
