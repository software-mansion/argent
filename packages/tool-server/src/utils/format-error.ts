import { FAILURE_CODES, FailureError, type FailureCode } from "@argent/registry";

/**
 * Walk the error `.cause` chain and build a single message containing the
 * top-level message plus any unique root-cause details the agent wouldn't
 * otherwise see (e.g. `fetch failed` wrapping `connect ECONNREFUSED …`).
 * Keeps output concise: skips causes whose text is already present in an
 * earlier part of the chain.
 */
export function formatErrorForAgent(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [err.message];
  const seen = new Set<unknown>([err]);
  let current = err.cause;
  // Bounded walk with a cycle guard: a self-referential `.cause` (e.g. an error
  // re-wrapped as its own ancestor) would otherwise loop forever.
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current);
    const msg = current.message;
    if (!parts.some((p) => p.includes(msg))) {
      parts.push(msg);
    }
    current = current.cause;
  }

  return parts.length === 1 ? parts[0]! : parts.join(" — caused by: ");
}

/**
 * Convert a network-level fetch error (timeout, ECONNREFUSED, ECONNRESET, …)
 * into a descriptive Error the agent can act on.
 *
 * @param toolLabel  Human-readable tool name used as the message prefix (e.g. "Describe", "Screenshot").
 * @param err        The raw error thrown by `fetch()`.
 * @param apiUrl     The simulator-server base URL that was being contacted.
 * @param fallbackHint  Optional extra sentence appended to timeout/generic messages
 *                      (e.g. "use the screenshot tool to visually inspect the screen instead.").
 */
export function toSimulatorNetworkError(
  toolLabel: string,
  err: unknown,
  apiUrl: string,
  fallbackHint?: string
): Error {
  if (!(err instanceof Error)) return new Error(String(err));

  const causeMsg = err.cause instanceof Error ? err.cause.message : "";
  const combined = `${err.message} ${causeMsg}`;
  const suffix = fallbackHint ? ` ${fallbackHint}` : "";

  const networkError = (
    message: string,
    errorCode: FailureCode,
    errorKind: "timeout" | "network" = "network"
  ): Error =>
    new FailureError(
      message,
      {
        error_code: errorCode,
        failure_stage: "simulator_server_network",
        failure_area: "tool_server",
        error_kind: errorKind,
        network_failure:
          errorCode === FAILURE_CODES.SIMULATOR_NETWORK_TIMEOUT
            ? "timeout"
            : errorCode === FAILURE_CODES.SIMULATOR_NETWORK_CONNECTION_REFUSED
              ? "connection_refused"
              : errorCode === FAILURE_CODES.SIMULATOR_NETWORK_CONNECTION_RESET
                ? "connection_reset"
                : "other",
      },
      { cause: err }
    );

  if (err.name === "AbortError" || combined.includes("aborted")) {
    return networkError(
      `${toolLabel} timed out — simulator-server at ${apiUrl} did not respond in time. ` +
        `The simulator may be unresponsive.${suffix}`,
      FAILURE_CODES.SIMULATOR_NETWORK_TIMEOUT,
      "timeout"
    );
  }

  const recovery =
    "If the simulator is booted, call stop-simulator-server for that UDID and retry this action — " +
    "the next simulator tool call (gesture, screenshot, etc.) starts a fresh simulator-server process.";

  if (combined.includes("ECONNREFUSED")) {
    return networkError(
      `${toolLabel} failed: cannot connect to simulator-server (connection refused at ${apiUrl}). ` +
        `The native server process may have crashed or not be listening yet. ${recovery}`,
      FAILURE_CODES.SIMULATOR_NETWORK_CONNECTION_REFUSED
    );
  }

  if (combined.includes("ECONNRESET") || combined.includes("socket hang up")) {
    return networkError(
      `${toolLabel} failed: connection to simulator-server was reset (${apiUrl}). ` +
        `The server may have crashed mid-request. ${recovery}`,
      FAILURE_CODES.SIMULATOR_NETWORK_CONNECTION_RESET
    );
  }

  return networkError(
    `${toolLabel} failed: network error communicating with simulator-server at ${apiUrl}: ` +
      `${err.message}${causeMsg ? ` (${causeMsg})` : ""}. ` +
      `Verify the simulator is booted. ${recovery}${suffix}`,
    FAILURE_CODES.SIMULATOR_NETWORK_ERROR
  );
}
