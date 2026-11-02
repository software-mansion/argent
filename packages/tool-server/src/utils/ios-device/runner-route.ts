import { sleep } from "../timing";
import net from "node:net";
import { once } from "node:events";
import { postRunnerCommand } from "./runner-http";
import { createDeadline, openUsbmuxRunnerSocket, type Deadline } from "./usbmux";
import { IosDeviceTransportError, isIosDeviceTransportError } from "./usbmux-protocol";

/**
 * Send a command to the runner over USB or an authenticated CoreDevice tunnel.
 * Mutating commands go out at most once. Read-only commands retry on retryable errors.
 */

const READ_ONLY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 2_000;

export interface SendRunnerCommandOptions {
  timeoutMs: number;
  /**
   * Read-only commands are idempotent and may be retried on retryable transport errors.
   * Mutating commands (the default) are sent at most once.
   */
  readOnly?: boolean;
}

export type SendRunnerCommand = (
  udid: string,
  port: number,
  body: unknown,
  options: SendRunnerCommandOptions
) => Promise<unknown>;

/**
 * Create a sender for the route selected when the runner starts.
 *
 * @param options.sendViaUsbmux test seam. Replaces the usbmux socket and HTTP send.
 */
export function createRunnerCommandSender(
  options: {
    network?: { address: string; token: string };
    sendViaUsbmux?: (
      udid: string,
      port: number,
      body: unknown,
      deadline: Deadline
    ) => Promise<unknown>;
  } = {}
): { sendCommand: SendRunnerCommand } {
  const network = options.network;
  const send = network
    ? (_udid: string, port: number, body: unknown, deadline: Deadline) =>
        postRunnerCommand({
          socketFactory: () => openTunnelSocket(network.address, port, deadline),
          authorizationToken: network.token,
          body,
          deadline,
        })
    : (options.sendViaUsbmux ?? defaultSendViaUsbmux);

  return {
    sendCommand: async (udid, port, body, sendOptions) => {
      if (!sendOptions.readOnly) {
        return send(udid, port, body, createDeadline(sendOptions.timeoutMs));
      }

      let lastError: unknown;

      for (let attempt = 1; attempt <= READ_ONLY_MAX_ATTEMPTS; attempt += 1) {
        try {
          // Fresh deadline per attempt. Backoff sleeps do not spend from timeoutMs.
          return await send(udid, port, body, createDeadline(sendOptions.timeoutMs));
        } catch (error) {
          lastError = error;
          const retryable = isIosDeviceTransportError(error) && error.retryable;

          if (!retryable || attempt === READ_ONLY_MAX_ATTEMPTS) {
            throw error;
          }

          await sleep(Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS));
        }
      }

      // Unreachable: the loop always returns or throws. Kept for the type checker.
      throw lastError;
    },
  };
}

async function openTunnelSocket(
  address: string,
  port: number,
  deadline: Deadline
): Promise<net.Socket> {
  const timeoutMs = deadline.remainingMs();
  if (timeoutMs <= 0) {
    throw new IosDeviceTransportError("timeout", "CoreDevice connection deadline elapsed", {
      retryable: true,
    });
  }
  const socket = net.createConnection({ host: address, port, family: 6 });
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await once(socket, "connect", { signal });
    socket.pause();
    return socket;
  } catch (error) {
    socket.destroy();
    throw new IosDeviceTransportError(
      signal.aborted ? "timeout" : "runner-not-listening",
      "Cannot connect to the runner through the CoreDevice tunnel",
      { retryable: true, cause: error }
    );
  }
}

/**
 * Send one command over a usbmux socket and HTTP POST.
 */
function defaultSendViaUsbmux(
  udid: string,
  port: number,
  body: unknown,
  deadline: Deadline
): Promise<unknown> {
  // One deadline covers the handshake and the HTTP exchange.
  return postRunnerCommand({
    socketFactory: () => openUsbmuxRunnerSocket({ udid, port, timeoutMs: deadline.remainingMs() }),
    body,
    deadline,
  });
}
