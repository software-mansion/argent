import bytesUtil from "bytes";

/**
 * Format a byte count as a compact, no-space size string (`512B`, `1.5KB`,
 * `2GB`) for profiler report tables. Shared by the combined report and the
 * stack-query renderer; note the iOS analysis report uses a distinct spaced
 * format (`1.5 MB`).
 *
 * Delegates to `bytes` (base-1024, KB/MB/GB/TB labels) so leak totals above
 * 1 GB render as `2.1GB` instead of the old hand-rolled helper's `2148.0MB`
 * (it capped at an MB tier).
 */
export function formatBytes(bytes: number): string {
  return bytesUtil(bytes, { decimalPlaces: 1 }) ?? `${bytes}B`;
}
