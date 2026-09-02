import { randomUUID } from "node:crypto";
import { FAILURE_CODES, withFailureSignal, type FailureSignal } from "@argent/registry";
import { sleep, type SendRunnerCommand } from "./runner-route";
import {
  appendHintToMessage,
  IosDeviceTransportError,
  isIosDeviceTransportError,
  type IosDeviceTransportErrorKind,
} from "./usbmux-protocol";

/**
 * Command client for the on-device XCUITest runner.
 * Stamps command ids, unwraps the JSON envelope, and recovers lost mutating-command responses.
 */

export const RUNNER_COMMAND_TIMEOUT_MS = 45_000;
const RUNNER_STATUS_RECOVERY_TIMEOUT_MS = 3_000;
const RUNNER_READY_POLL_INTERVAL_MS = 250;
const RUNNER_READY_PROBE_TIMEOUT_MS = 2_000;

const RUNNER_BUSY_ERROR_CODE = "RUNNER_BUSY";
const INVALID_RUNNER_RESPONSE_CODE = "INVALID_RUNNER_RESPONSE";

export interface RunnerCommand {
  command: string;
  commandId?: string;
  statusCommandId?: string;
  [key: string]: unknown;
}

export interface RunnerResponseError {
  code?: string;
  message: string;
  hint?: string;
}

export interface RunnerResponseEnvelope {
  ok: boolean;
  data?: unknown;
  error?: RunnerResponseError;
  /**
   * The runner re-fronted a backgrounded target app before this command.
   * Encoded only when true.
   */
  reactivated?: boolean;
  /**
   * Advisory on an ok reply when suppressed accessibility noise grew during the mutation.
   * Encoded only when set.
   */
  warning?: string;
}

/** Folded into a failure's message when its envelope carried `reactivated: true`. */
const REACTIVATED_NOTE =
  "The app was re-fronted before the command ran, so the foreground screen changed.";

function appendSentence(message: string, sentence: string): string {
  return `${message}${/[.!?]$/.test(message) ? "" : "."} ${sentence}`;
}

/**
 * A failure the runner reported in an `ok: false` envelope.
 * `retryable` is true only for `RUNNER_BUSY`.
 */
export class RunnerCommandError extends Error {
  readonly code?: string;
  /** Callers may branch on this. The message already includes the same text. */
  readonly hint?: string;
  readonly retryable: boolean;
  /**
   * The runner re-fronted a backgrounded target before the command ran, and
   * the command then failed: the foreground screen changed even though the
   * action did not land. The message already says so.
   */
  readonly reactivated: boolean;

  constructor(
    message: string,
    options: { code?: string; hint?: string; reactivated?: boolean } = {}
  ) {
    super(
      appendHintToMessage(
        options.reactivated === true ? appendSentence(message, REACTIVATED_NOTE) : message,
        options.hint
      )
    );
    this.name = "RunnerCommandError";

    if (options.code !== undefined) {
      this.code = options.code;
    }

    if (options.hint !== undefined) {
      this.hint = options.hint;
    }

    this.retryable = options.code === RUNNER_BUSY_ERROR_CODE;
    this.reactivated = options.reactivated === true;

    // Classify the failure here. The runner wire code stays on `code`.
    withFailureSignal(this, {
      error_code: FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED,
      failure_stage: "ios_device_runner_command",
      failure_area: "tool_server",
      error_kind: "unknown",
    });
  }
}

/**
 * Failure signal for a transport error.
 */
function transportFailureSignal(kind: IosDeviceTransportErrorKind): FailureSignal {
  // Stamp here. usbmux-protocol cannot import `@argent/registry`.
  const base = {
    error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
    failure_stage: "ios_device_runner_transport",
    failure_area: "tool_server",
  } as const;

  switch (kind) {
    case "device-unattached":
      return { ...base, error_kind: "not_found" };
    case "runner-not-listening":
      return { ...base, error_kind: "network", network_failure: "connection_refused" };
    case "timeout":
      return { ...base, error_kind: "timeout" };
    case "protocol":
      return { ...base, error_kind: "network", network_failure: "invalid_response" };
    case "http":
      return { ...base, error_kind: "network", network_failure: "other" };
  }
}

export interface RunCommandOptions {
  /** Read-only commands may be retried by the send layer. */
  readOnly?: boolean;
  timeoutMs?: number;
}

export interface RunnerClient {
  /**
   * Send a command to the runner and return the unwrapped result.
   */
  run(command: Record<string, unknown>, options?: RunCommandOptions): Promise<unknown>;
}

/**
 * Create a runner command client.
 *
 * @param options.send injected send. The client does not own the transport.
 */
export function createRunnerClient(options: {
  udid: string;
  port: number;
  send: SendRunnerCommand;
}): RunnerClient {
  const run = async (
    command: Record<string, unknown>,
    runOptions: RunCommandOptions = {}
  ): Promise<unknown> => {
    const timeoutMs = runOptions.timeoutMs ?? RUNNER_COMMAND_TIMEOUT_MS;
    const readOnly = runOptions.readOnly === true;
    const stamped = withCommandId(command);
    const commandId = typeof stamped.commandId === "string" ? stamped.commandId : undefined;

    try {
      const response = await options.send(options.udid, options.port, stamped, {
        timeoutMs,
        readOnly,
      });

      return unwrapEnvelope(response);
    } catch (error) {
      if (!isIosDeviceTransportError(error)) {
        throw error;
      }

      // Stamp once here. Every path below rethrows this same object.
      withFailureSignal(error, transportFailureSignal(error.kind));

      // Read-only already retried at the send layer. Status must not recurse into recovery.
      if (readOnly || command.command === "status" || !commandId) {
        throw error;
      }

      // Pre-send kinds never opened a connection. The command cannot have run.
      if (error.kind === "device-unattached" || error.kind === "runner-not-listening") {
        throw error;
      }

      return await recoverAfterLostResponse(stamped, commandId, error);
    }
  };

  /**
   * The mutating-command lost-response protocol. Asks the runner for the fate
   * of the exact commandId that was in flight.
   */
  const recoverAfterLostResponse = async (
    command: Record<string, unknown>,
    commandId: string,
    transportError: IosDeviceTransportError
  ): Promise<unknown> => {
    let status: Record<string, unknown>;

    try {
      const response = await options.send(
        options.udid,
        options.port,
        { command: "status", statusCommandId: commandId },
        { timeoutMs: RUNNER_STATUS_RECOVERY_TIMEOUT_MS, readOnly: true }
      );

      const data = unwrapEnvelope(response);

      status = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    } catch {
      // Status probe failed. Rethrow the original transport error.
      throw transportError;
    }

    const state = typeof status.state === "string" ? status.state : "";

    if (state === "completed") {
      const retained = parseRetainedResponse(status.responseJson);

      // Retained JSON is the lost envelope. Unwrap it as the real outcome.
      if (retained && asEnvelope(retained)) {
        return unwrapEnvelope(retained);
      }

      // Completed with no usable retained response. The effect happened. Surface the transport error.
      throw transportError;
    }

    if (state === "failed") {
      throw new RunnerCommandError(
        typeof status.errorMessage === "string"
          ? status.errorMessage
          : `Runner command "${String(command.command)}" failed`,
        {
          code: typeof status.errorCode === "string" ? status.errorCode : undefined,
          hint: typeof status.errorHint === "string" ? status.errorHint : undefined,
        }
      );
    }

    throw transportError;
  };

  return { run };
}

/**
 * Poll `status` until the runner returns a parsed envelope.
 */
export async function waitForRunnerReady(
  client: RunnerClient,
  options: { timeoutMs: number }
): Promise<void> {
  const expiresAt = Date.now() + options.timeoutMs;
  let lastError: unknown;

  for (;;) {
    const remainingMs = expiresAt - Date.now();

    if (remainingMs <= 0) {
      throw withFailureSignal(
        new IosDeviceTransportError(
          "timeout",
          `Runner did not become ready within ${options.timeoutMs}ms`,
          { retryable: false, cause: lastError }
        ),
        transportFailureSignal("timeout")
      );
    }

    try {
      await client.run(
        { command: "status" },
        { readOnly: true, timeoutMs: Math.min(remainingMs, RUNNER_READY_PROBE_TIMEOUT_MS) }
      );

      return;
    } catch (error) {
      if (error instanceof RunnerCommandError && error.code !== INVALID_RUNNER_RESPONSE_CODE) {
        // An ok:false envelope still counts. It proves the HTTP stack is up.
        return;
      }

      // A non-envelope reply does not count. Only an envelope proves the runner answered.
      lastError = error;
    }

    await sleep(RUNNER_READY_POLL_INTERVAL_MS);
  }
}

/**
 * Stamp a fresh command id on every non-status command that does not already have one.
 */
function withCommandId(command: Record<string, unknown>): Record<string, unknown> {
  if (command.command === "status" || typeof command.commandId === "string") {
    return command;
  }

  return { ...command, commandId: `argent-${randomUUID()}` };
}

function unwrapEnvelope(response: unknown): unknown {
  const envelope = asEnvelope(response);

  if (!envelope) {
    throw new RunnerCommandError("Runner returned an unrecognized response shape", {
      code: INVALID_RUNNER_RESPONSE_CODE,
    });
  }

  if (envelope.ok) {
    return withEnvelopeMarkers(envelope);
  }

  throw new RunnerCommandError(envelope.error?.message ?? "Runner command failed", {
    code: envelope.error?.code,
    hint: envelope.error?.hint,
    reactivated: envelope.reactivated === true,
  });
}

/**
 * Copy `reactivated` and `warning` from a success envelope onto the data object.
 */
function withEnvelopeMarkers(envelope: RunnerResponseEnvelope): unknown {
  const reactivated = envelope.reactivated === true;
  const warning = typeof envelope.warning === "string" ? envelope.warning : undefined;

  if (!reactivated && warning === undefined) {
    return envelope.data;
  }

  const data = envelope.data;

  // Markers attach only to object data.
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return data;
  }

  return {
    ...data,
    ...(reactivated ? { reactivated: true } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}

function asEnvelope(response: unknown): RunnerResponseEnvelope | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }

  const candidate = response as { ok?: unknown };

  if (typeof candidate.ok !== "boolean") {
    return null;
  }

  return response as RunnerResponseEnvelope;
}

function parseRetainedResponse(value: unknown): unknown | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
