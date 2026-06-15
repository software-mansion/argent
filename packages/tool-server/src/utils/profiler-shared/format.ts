/**
 * Format a byte count as a compact, no-space size string (`512B`, `1.5KB`,
 * `2.0MB`) for profiler report tables. Shared by the combined report and the
 * stack-query renderer; note the iOS analysis report uses a distinct spaced
 * format (`1.5 MB`) and intentionally does not use this helper.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
