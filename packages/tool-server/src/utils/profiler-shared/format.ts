import bytesUtil from "bytes";

/**
 * Compact, no-space size string (`512B`, `1.5KB`, `2GB`) for profiler report
 * tables. The iOS analysis report uses a spaced variant (`1.5 MB`) instead.
 */
export function formatBytes(bytes: number): string {
  return bytesUtil(bytes, { decimalPlaces: 1 }) ?? `${bytes}B`;
}

/**
 * GFM splits table cells on unescaped `|` even inside code spans, and demangled
 * C++ frames such as `folly::operator|(...)` contain one.
 */
export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
