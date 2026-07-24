// ── Service Errors ──

import { FAILURE_CODES, type FailureCode } from "./failure-codes";

export const FAILURE_AREAS = ["cli", "http", "registry", "tool_server", "installer"] as const;

export type FailureArea = (typeof FAILURE_AREAS)[number];

export const FAILURE_KINDS = [
  "validation",
  "not_found",
  "dependency_missing",
  "unsupported",
  "not_implemented",
  "timeout",
  "network",
  "subprocess",
  "crash",
  "unknown",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export const FAILURE_COMMANDS = [
  "adb",
  "emulator",
  "vega",
  "xcrun_simctl",
  "xctrace",
  "native_devtools",
  "android_devtools",
  "ax_service",
  "simulator_server",
  "ffmpeg",
  "cdp",
  "electron",
  "npm",
  "npx",
  "unknown",
] as const;

export type FailureCommand = (typeof FAILURE_COMMANDS)[number];

export const FAILURE_SIGNAL_NAMES = [
  "SIGABRT",
  "SIGHUP",
  "SIGINT",
  "SIGKILL",
  "SIGQUIT",
  "SIGTERM",
] as const;

export type FailureSignalName = (typeof FAILURE_SIGNAL_NAMES)[number];

export const FAILURE_SPAWN_CODES = ["EACCES", "ENOENT", "EPERM", "ETIMEDOUT"] as const;

export type FailureSpawnCode = (typeof FAILURE_SPAWN_CODES)[number];

export const NETWORK_FAILURES = [
  "timeout",
  "connection_refused",
  "connection_reset",
  "invalid_response",
  "other",
] as const;

export type NetworkFailure = (typeof NETWORK_FAILURES)[number];

export interface FailureSignal {
  /** Static, searchable code. Never derive this from an Error message. */
  error_code: FailureCode;
  /** Static source-location hint, e.g. `http_zod_validation` or `registry_execute`. */
  failure_stage: string;
  failure_area: FailureArea;
  error_kind: FailureKind;
  /** Optional coarse command category; never a command line or argv. */
  failure_command?: FailureCommand;
  /** Optional process exit code; sanitized to a small non-negative integer. */
  failure_exit_code?: number;
  /** Optional allowlisted POSIX signal name. */
  failure_signal?: FailureSignalName;
  /** Optional allowlisted spawn failure code. */
  failure_spawn_code?: FailureSpawnCode;
  /** Optional coarse network failure class; never a URL, host, or port. */
  network_failure?: NetworkFailure;
}

const FAILURE_SIGNAL = Symbol("argent.failure_signal");

const FALLBACK_SIGNAL: FailureSignal = {
  error_code: FAILURE_CODES.ARGENT_UNCLASSIFIED_FAILURE,
  failure_stage: "unclassified",
  failure_area: "registry",
  error_kind: "unknown",
};

export class FailureError extends Error {
  constructor(message: string, signal: FailureSignal, options?: { cause?: Error }) {
    super(message, options);
    this.name = "FailureError";
    withFailureSignal(this, signal);
  }
}

export function failureSignal(
  error_code: FailureCode,
  failure_stage: string,
  failure_area: FailureArea,
  error_kind: FailureKind
): FailureSignal {
  return { error_code, failure_stage, failure_area, error_kind };
}

export function withFailureSignal<T extends Error>(error: T, signal: FailureSignal): T {
  Object.defineProperty(error, FAILURE_SIGNAL, {
    value: signal,
    enumerable: false,
    configurable: true,
  });
  return error;
}

export function getFailureSignal(error: unknown): FailureSignal | null {
  // Bounded breadth-first walk so the shallowest (outermost) signal still wins,
  // while also descending into AggregateError.errors — a signal attached to an
  // aggregated sub-error would otherwise be missed. The visited set guards
  // against cyclic `.cause`/`.errors` references.
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  for (let visited = 0; visited < 16 && queue.length > 0; visited++) {
    const current = queue.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    const signal = (current as Error & { [FAILURE_SIGNAL]?: FailureSignal })[FAILURE_SIGNAL];
    if (signal) return signal;
    if (current.cause !== undefined) queue.push(current.cause);
    if (current instanceof AggregateError) {
      for (const aggregated of current.errors) queue.push(aggregated);
    }
  }
  return null;
}

export function getFailureSignalOrFallback(
  error: unknown,
  fallback: FailureSignal = FALLBACK_SIGNAL
): FailureSignal {
  return getFailureSignal(error) ?? fallback;
}

export function wrapFailure(
  error: unknown,
  fallback: FailureSignal,
  message?: string
): FailureError {
  const cause = error instanceof Error ? error : new Error(String(error));
  return new FailureError(message ?? cause.message, getFailureSignalOrFallback(cause, fallback), {
    cause,
  });
}

const FAILURE_SIGNAL_NAME_SET = new Set<FailureSignalName>(FAILURE_SIGNAL_NAMES);

const FAILURE_SPAWN_CODE_SET = new Set<FailureSpawnCode>(FAILURE_SPAWN_CODES);

export function subprocessFailureMetadata(
  error: unknown,
  failure_command: FailureCommand
): Pick<
  FailureSignal,
  "failure_command" | "failure_exit_code" | "failure_signal" | "failure_spawn_code"
> {
  const metadata: Pick<
    FailureSignal,
    "failure_command" | "failure_exit_code" | "failure_signal" | "failure_spawn_code"
  > = { failure_command };
  const err = error as {
    code?: string | number | null;
    signal?: string | null;
  };
  if (
    typeof err.code === "number" &&
    Number.isInteger(err.code) &&
    err.code >= 0 &&
    err.code <= 255
  ) {
    metadata.failure_exit_code = err.code;
  } else if (
    typeof err.code === "string" &&
    FAILURE_SPAWN_CODE_SET.has(err.code as FailureSpawnCode)
  ) {
    metadata.failure_spawn_code = err.code as FailureSpawnCode;
  }
  if (
    typeof err.signal === "string" &&
    FAILURE_SIGNAL_NAME_SET.has(err.signal as FailureSignalName)
  ) {
    metadata.failure_signal = err.signal as FailureSignalName;
  }
  return metadata;
}

export class ServiceNotFoundError extends Error {
  public readonly serviceId: string;
  constructor(serviceId: string) {
    super(`Service "${serviceId}" not found`);
    this.name = "ServiceNotFoundError";
    this.serviceId = serviceId;
    withFailureSignal(this, {
      error_code: FAILURE_CODES.REGISTRY_SERVICE_NOT_FOUND,
      failure_stage: "registry_resolve_service",
      failure_area: "registry",
      error_kind: "not_found",
    });
  }
}

export class ServiceInitializationError extends Error {
  public readonly serviceId: string;
  constructor(serviceId: string, message: string, options?: { cause?: Error }) {
    super(`[${serviceId}] ${message}`, options);
    this.name = "ServiceInitializationError";
    this.serviceId = serviceId;
    withFailureSignal(
      this,
      getFailureSignalOrFallback(options?.cause, {
        error_code: FAILURE_CODES.REGISTRY_SERVICE_INITIALIZATION_FAILED,
        failure_stage: "registry_initialize_service",
        failure_area: "registry",
        error_kind: "unknown",
      })
    );
  }
}

// ── Tool Errors ──

export class ToolNotFoundError extends Error {
  public readonly toolId: string;
  constructor(toolId: string) {
    super(`Tool "${toolId}" not found`);
    this.name = "ToolNotFoundError";
    this.toolId = toolId;
    withFailureSignal(this, {
      error_code: FAILURE_CODES.REGISTRY_TOOL_NOT_FOUND,
      failure_stage: "registry_lookup_tool",
      failure_area: "registry",
      error_kind: "not_found",
    });
  }
}

export class ToolExecutionError extends Error {
  public readonly toolId: string;
  constructor(toolId: string, message: string, options?: { cause?: Error }) {
    super(`[Tool:${toolId}] ${message}`, options);
    this.name = "ToolExecutionError";
    this.toolId = toolId;
    withFailureSignal(
      this,
      getFailureSignalOrFallback(options?.cause, {
        error_code: FAILURE_CODES.REGISTRY_TOOL_EXECUTION_FAILED,
        failure_stage: "registry_execute_tool",
        failure_area: "registry",
        error_kind: "unknown",
      })
    );
  }
}
