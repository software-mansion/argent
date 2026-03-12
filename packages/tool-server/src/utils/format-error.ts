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
  let current = err.cause;
  while (current instanceof Error) {
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
  fallbackHint?: string,
): Error {
  if (!(err instanceof Error)) return new Error(String(err));

  const causeMsg = err.cause instanceof Error ? err.cause.message : "";
  const combined = `${err.message} ${causeMsg}`;
  const suffix = fallbackHint ? ` ${fallbackHint}` : "";

  if (err.name === "AbortError" || combined.includes("aborted")) {
    return new Error(
      `${toolLabel} timed out — simulator-server at ${apiUrl} did not respond in time. ` +
      `The simulator may be unresponsive.${suffix}`
    );
  }

  if (combined.includes("ECONNREFUSED")) {
    return new Error(
      `${toolLabel} failed: cannot connect to simulator-server (connection refused at ${apiUrl}). ` +
      `The server process may have crashed or was never started. ` +
      `Call the simulator-server tool to restart it, then retry.`
    );
  }

  if (combined.includes("ECONNRESET") || combined.includes("socket hang up")) {
    return new Error(
      `${toolLabel} failed: connection to simulator-server was reset (${apiUrl}). ` +
      `The server may have crashed mid-request. ` +
      `Call the simulator-server tool to restart it, then retry.`
    );
  }

  return new Error(
    `${toolLabel} failed: network error communicating with simulator-server at ${apiUrl}: ` +
    `${err.message}${causeMsg ? ` (${causeMsg})` : ""}. ` +
    `Verify the simulator is running and the server is healthy.${suffix}`
  );
}
