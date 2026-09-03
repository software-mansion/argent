import http from "node:http";
import net from "node:net";
import { requireTimeRemaining, type Deadline } from "./usbmux";
import { IosDeviceTransportError } from "./usbmux-protocol";

/**
 * POST one command to the XCUITest runner over a pre-connected socket.
 */

/** Cap on runner response size. */
const RUNNER_HTTP_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

interface PostRunnerCommandOptions {
  socketFactory: () => Promise<net.Socket>;
  body: unknown;
  deadline: Deadline;
}

/**
 * POST one runner command over a pre-connected socket. Resolves with the parsed JSON body.
 *
 * @param options.socketFactory opens the usbmux socket when the send starts.
 * @param options.deadline send budget, shared with the usbmux handshake.
 */
export async function postRunnerCommand(options: PostRunnerCommandOptions): Promise<unknown> {
  requireTimeRemaining(options.deadline.remainingMs(), "send runner command");

  const socket = await options.socketFactory();
  const agent = new http.Agent({ keepAlive: false });

  // node:http cannot dial a usbmux socket. A throwaway Agent injects the pre-connected one.
  agent.createConnection = ((
    _options: unknown,
    callback?: (err: Error | null, stream: net.Socket) => void
  ) => {
    callback?.(null, socket);
    return socket;
  }) as typeof agent.createConnection;

  try {
    const payload = Buffer.from(JSON.stringify(options.body), "utf8");

    // Re-read remaining time after the handshake.
    const httpTimeoutMs = options.deadline.remainingMs();
    requireTimeRemaining(httpTimeoutMs, "send runner command");

    const response = await requestOverAgent(agent, socket, payload, httpTimeoutMs);

    return parseRunnerResponseBody(response.statusCode, response.body);
  } finally {
    agent.destroy();
    socket.destroy();
  }
}

async function requestOverAgent(
  agent: http.Agent,
  socket: net.Socket,
  payload: Buffer,
  timeoutMs: number
): Promise<{ statusCode: number; body: Buffer }> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  try {
    return await new Promise((resolve, reject) => {
      const request = http.request(
        {
          method: "POST",
          // Host header only because the connection is the injected socket.
          host: "127.0.0.1",
          path: "/command",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": payload.length,
            "Connection": "close",
          },
          agent,
          signal: timeoutSignal,
        },
        (response) => {
          readBoundedBody(response).then(
            (body) => resolve({ statusCode: response.statusCode ?? 500, body }),
            reject
          );
        }
      );

      request.once("error", reject);
      // Resume the paused usbmux socket. The HTTP response arrives on this pipe.
      socket.resume();
      request.end(payload);
    });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new IosDeviceTransportError(
        "timeout",
        `Timed out waiting for XCUITest runner response after ${timeoutMs}ms`,
        { retryable: true, cause: error }
      );
    }

    if (error instanceof IosDeviceTransportError) {
      throw error;
    }

    throw new IosDeviceTransportError(
      "http",
      `Runner HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, cause: error }
    );
  }
}

async function readBoundedBody(response: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    totalBytes += buffer.length;

    if (totalBytes > RUNNER_HTTP_MAX_RESPONSE_BYTES) {
      throw new IosDeviceTransportError(
        "protocol",
        `Runner response exceeded ${RUNNER_HTTP_MAX_RESPONSE_BYTES} bytes`,
        { retryable: false }
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

/**
 * Parse the runner response body as JSON.
 */
function parseRunnerResponseBody(statusCode: number, body: Buffer): unknown {
  const text = body.toString("utf8");

  // Command failures live in the JSON envelope. Only an unparseable body is a transport failure.
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new IosDeviceTransportError(
      "http",
      `Runner returned non-JSON response (HTTP ${statusCode})`,
      { retryable: false }
    );
  }
}
