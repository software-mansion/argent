import http from "node:http";
import net from "node:net";
import { requireTimeRemaining, type Deadline } from "./usbmux";
import { IosDeviceTransportError } from "./usbmux-protocol";

/**
 * POST one command to the XCUITest runner over a usbmux socket.
 */

/** Cap on runner response size. */
const RUNNER_HTTP_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Request option that hands a command's usbmux socket factory to the keep-alive agent. */
const SOCKET_FACTORY_OPTION = "argentRunnerSocketFactory";

interface PostRunnerCommandOptions {
  socketFactory: () => Promise<net.Socket>;
  body: unknown;
  deadline: Deadline;
  /**
   * Agent from `createRunnerKeepAliveAgent`. The command then reuses an idle connection to the
   * runner when one is open, and opens one through `socketFactory` only when none is.
   * Without it every command opens a connection and closes it after the reply.
   */
  keepAliveAgent?: http.Agent;
}

/**
 * An agent that keeps connections to one runner open between commands.
 *
 * Each usbmux connection costs a `Connect` round trip to usbmuxd before the first byte reaches the
 * runner; a device reached through a remote usbmuxd pays network latency for it on every command.
 * A runner that does not answer `Connection: keep-alive` closes each connection as before, and the
 * agent then opens a new one for the next command.
 */
export function createRunnerKeepAliveAgent(): http.Agent {
  const agent = new http.Agent({ keepAlive: true });

  // node:http cannot dial usbmux. The agent calls this only when no idle connection is free, and
  // asks the command that needs the connection for its socket factory.
  agent.createConnection = ((
    options: Record<string, unknown>,
    callback: (err: Error | null, stream?: net.Socket) => void
  ) => {
    const socketFactory = options[SOCKET_FACTORY_OPTION] as (() => Promise<net.Socket>) | undefined;

    if (!socketFactory) {
      callback(new Error("The runner keep-alive agent needs a socket factory per request"));
      return undefined;
    }

    socketFactory().then(
      (socket) => {
        // The usbmux socket arrives paused. The HTTP response arrives on this pipe.
        socket.resume();
        callback(null, socket);
      },
      (error: Error) => callback(error)
    );

    return undefined;
  }) as unknown as typeof agent.createConnection;

  return agent;
}

/**
 * POST one runner command. Resolves with the parsed JSON body.
 *
 * @param options.socketFactory opens the usbmux socket when the send needs a new connection.
 * @param options.deadline send budget, shared with the usbmux handshake.
 */
export async function postRunnerCommand(options: PostRunnerCommandOptions): Promise<unknown> {
  requireTimeRemaining(options.deadline.remainingMs(), "send runner command");

  if (options.keepAliveAgent) {
    const payload = Buffer.from(JSON.stringify(options.body), "utf8");
    // One budget covers the usbmux handshake, when a new connection is needed, and the exchange.
    const response = await requestOverAgent(
      options.keepAliveAgent,
      payload,
      options.deadline.remainingMs(),
      { socketFactory: options.socketFactory }
    );

    return parseRunnerResponseBody(response.statusCode, response.body);
  }

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

    const response = await requestOverAgent(agent, payload, httpTimeoutMs, { socket });

    return parseRunnerResponseBody(response.statusCode, response.body);
  } finally {
    agent.destroy();
    socket.destroy();
  }
}

async function requestOverAgent(
  agent: http.Agent,
  payload: Buffer,
  timeoutMs: number,
  connection: { socket: net.Socket } | { socketFactory: () => Promise<net.Socket> }
): Promise<{ statusCode: number; body: Buffer }> {
  const keepAlive = "socketFactory" in connection;
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
            "Connection": keepAlive ? "keep-alive" : "close",
          },
          agent,
          signal: timeoutSignal,
          ...(keepAlive ? { [SOCKET_FACTORY_OPTION]: connection.socketFactory } : {}),
        } as http.RequestOptions,
        (response) => {
          readBoundedBody(response).then(
            (body) => resolve({ statusCode: response.statusCode ?? 500, body }),
            reject
          );
        }
      );

      request.once("error", reject);
      if ("socket" in connection) {
        // Resume the paused usbmux socket. The HTTP response arrives on this pipe.
        connection.socket.resume();
      }
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
