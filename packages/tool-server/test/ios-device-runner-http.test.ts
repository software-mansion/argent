import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { postRunnerCommand } from "../src/utils/ios-device/runner-http";
import { createDeadline } from "../src/utils/ios-device/usbmux";
import { IosDeviceTransportError } from "../src/utils/ios-device/usbmux-protocol";

/**
 * postRunnerCommand end to end against a real HTTP server, over a socket
 * paused exactly the way the usbmux handshake leaves it: readOnePacket
 * (usbmux.ts) calls socket.pause() in its finish(), and an explicitly paused
 * stream does NOT start flowing again just because the HTTP parser attaches a
 * data listener. So every success below also stands on postRunnerCommand's
 * socket.resume(): without that one line no response ever reaches the client
 * and each of them becomes a deadline timeout instead.
 */

/** Mirrors runner-http's private RUNNER_HTTP_MAX_RESPONSE_BYTES. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

interface RecordedRequest {
  method?: string;
  url?: string;
  contentType?: string;
  body: string;
}

const openServers: http.Server[] = [];
const openSockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(
    openServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

/** A loopback runner stand-in; `respond` runs once the whole request is in. */
async function startRunnerServer(
  respond: (request: http.IncomingMessage, response: http.ServerResponse) => void
): Promise<{ port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        contentType: request.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      respond(request, response);
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, requests };
}

/** A connected socket, paused the way readOnePacket hands the usbmux one over. */
async function connectPaused(port: number): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1");
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    // Stays attached on purpose: a mid-exchange reset must not surface as an
    // unhandled 'error' event once this promise has settled.
    socket.once("error", reject);
  });
  socket.pause();
  return socket;
}

/** Flood the response past the cap, giving up as soon as the client hangs up. */
function floodResponse(response: http.ServerResponse, totalBytes: number): void {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let written = 0;
  const pump = () => {
    while (written < totalBytes) {
      if (response.destroyed) return;
      written += chunk.length;
      if (!response.write(chunk)) {
        response.once("drain", pump);
        return;
      }
    }
    response.end();
  };
  response.on("error", () => {});
  pump();
}

const errorFrom = (promise: Promise<unknown>): Promise<IosDeviceTransportError> =>
  promise.then(
    () => {
      throw new Error("expected the send to reject");
    },
    (caught: unknown) => caught as IosDeviceTransportError
  );

describe("postRunnerCommand over a paused usbmux-style socket", () => {
  it("POSTs the JSON body to /command and resolves with the parsed envelope", async () => {
    const envelope = { ok: true, data: { state: "idle" } };
    const { port, requests } = await startRunnerServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(envelope));
    });
    let opened: net.Socket | undefined;

    const result = await postRunnerCommand({
      socketFactory: async () => {
        opened = await connectPaused(port);
        return opened;
      },
      body: { command: "status", commandId: "argent-1" },
      deadline: createDeadline(5_000),
    });

    expect(result).toEqual(envelope);
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/command",
        contentType: "application/json",
        body: JSON.stringify({ command: "status", commandId: "argent-1" }),
      },
    ]);
    // One request per connection: the socket goes down with the agent, so the
    // next send opens a fresh usbmux route instead of pooling a muxed one.
    expect(opened?.destroyed).toBe(true);
  });

  it("returns an ok:false envelope even when the runner answers with a non-2xx status", async () => {
    const envelope = { ok: false, error: { code: "RUNNER_BUSY", message: "busy" } };
    const { port } = await startRunnerServer((_request, response) => {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify(envelope));
    });

    const result = await postRunnerCommand({
      socketFactory: () => connectPaused(port),
      body: { command: "tap" },
      deadline: createDeadline(5_000),
    });

    // Command failures live inside the envelope, so the status code decides
    // nothing here; interpreting the envelope is the client layer's job.
    expect(result).toEqual(envelope);
  });

  it("reports an unparseable body as a non-retryable http failure naming the status", async () => {
    const { port } = await startRunnerServer((_request, response) => {
      response.writeHead(502, { "Content-Type": "text/html" });
      response.end("<html>something else answered this port</html>");
    });

    const error = await errorFrom(
      postRunnerCommand({
        socketFactory: () => connectPaused(port),
        body: { command: "status" },
        deadline: createDeadline(5_000),
      })
    );

    expect(error).toBeInstanceOf(IosDeviceTransportError);
    expect(error.kind).toBe("http");
    expect(error.retryable).toBe(false);
    // The status is the only diagnostic left once the body is not JSON.
    expect(error.message).toBe("Runner returned non-JSON response (HTTP 502)");
  });

  it("times out with the retryable timeout verdict when the runner never answers", async () => {
    const { port } = await startRunnerServer(() => {
      /* accepts the request, answers nothing */
    });

    const error = await errorFrom(
      postRunnerCommand({
        socketFactory: () => connectPaused(port),
        body: { command: "status" },
        deadline: createDeadline(250),
      })
    );

    expect(error.kind).toBe("timeout");
    // Retryable: the send layer may resend an idempotent command.
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/^Timed out waiting for XCUITest runner response after \d+ms$/);
  });

  it("reports a connection lost mid-exchange as a retryable http failure", async () => {
    const { port } = await startRunnerServer((request) => request.socket.destroy());

    const error = await errorFrom(
      postRunnerCommand({
        socketFactory: () => connectPaused(port),
        body: { command: "status" },
        deadline: createDeadline(5_000),
      })
    );

    expect(error.kind).toBe("http");
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/^Runner HTTP request failed: /);
  });

  it("aborts a response that outgrows the cap instead of buffering it", async () => {
    // The length is attacker-adjacent data from a USB peripheral: a corrupt
    // stream must not drive an unbounded allocation, however long it keeps
    // writing.
    const { port } = await startRunnerServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      floodResponse(response, MAX_RESPONSE_BYTES + 1024 * 1024);
    });

    const error = await errorFrom(
      postRunnerCommand({
        socketFactory: () => connectPaused(port),
        body: { command: "snapshot" },
        deadline: createDeadline(10_000),
      })
    );

    expect(error.kind).toBe("protocol");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(`Runner response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }, 15_000);
});
