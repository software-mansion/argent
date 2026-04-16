/**
 * Maximum time (ms) to wait for graceful cleanup before force-exiting the
 * process. Mirrors the same constant in the tool-server package — both sides
 * of the MCP ↔ tool-server boundary use the same grace period.
 */
export const PROCESS_TIMEOUT_MS = 5_000;
