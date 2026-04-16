/**
 * Maximum time (ms) to wait for graceful cleanup (server.close, registry.dispose,
 * child-process teardown) before force-exiting the process. Used by both the
 * normal shutdown path and the crash handler so the tool-server never hangs
 * indefinitely on exit.
 */
export const PROCESS_TIMEOUT_MS = 5_000;
