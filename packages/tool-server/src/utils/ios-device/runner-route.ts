import { sleep } from "../timing";
import type http from "node:http";
import { createRunnerKeepAliveAgent, postRunnerCommand } from "./runner-http";
import { createDeadline, openUsbmuxRunnerSocket, type Deadline } from "./usbmux";
import { isIosDeviceTransportError } from "./usbmux-protocol";

/**
 * Send a command to the runner over usbmux.
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
 * Create a sender that posts commands over usbmux. The sender keeps its connections to the runner
 * open between commands; `close` drops them.
 *
 * @param options.sendViaUsbmux test seam. Replaces the usbmux socket and HTTP send.
 */
export function createUsbmuxCommandSender(
  options: {
    sendViaUsbmux?: (
      udid: string,
      port: number,
      body: unknown,
      deadline: Deadline
    ) => Promise<unknown>;
  } = {}
): { sendCommand: SendRunnerCommand; close: () => void } {
  const agents = new Map<string, http.Agent>();
  const sendViaUsbmux =
    options.sendViaUsbmux ??
    ((udid: string, port: number, body: unknown, deadline: Deadline) => {
      const key = `${udid}:${port}`;
      let agent = agents.get(key);
      if (!agent) {
        agent = createRunnerKeepAliveAgent();
        agents.set(key, agent);
      }
      return sendViaUsbmuxOver(agent, udid, port, body, deadline);
    });

  return {
    close: () => {
      for (const agent of agents.values()) {
        agent.destroy();
      }
      agents.clear();
    },
    sendCommand: async (udid, port, body, sendOptions) => {
      if (!sendOptions.readOnly) {
        return sendViaUsbmux(udid, port, body, createDeadline(sendOptions.timeoutMs));
      }

      let lastError: unknown;

      for (let attempt = 1; attempt <= READ_ONLY_MAX_ATTEMPTS; attempt += 1) {
        try {
          // Fresh deadline per attempt. Backoff sleeps do not spend from timeoutMs.
          return await sendViaUsbmux(udid, port, body, createDeadline(sendOptions.timeoutMs));
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

/**
 * Send one command over a usbmux socket and HTTP POST.
 */
function sendViaUsbmuxOver(
  keepAliveAgent: http.Agent,
  udid: string,
  port: number,
  body: unknown,
  deadline: Deadline
): Promise<unknown> {
  // One deadline covers the handshake, when a new connection is needed, and the HTTP exchange.
  return postRunnerCommand({
    socketFactory: () => openUsbmuxRunnerSocket({ udid, port, timeoutMs: deadline.remainingMs() }),
    body,
    deadline,
    keepAliveAgent,
  });
}
