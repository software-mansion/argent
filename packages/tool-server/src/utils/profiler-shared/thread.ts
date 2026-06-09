/**
 * Normalise a raw thread descriptor into a stable display name shared across the
 * iOS aggregation and stack-query paths. Collapses the main thread and the
 * Hermes/JS thread to canonical labels, and strips the hex thread id + pid suffix
 * Instruments appends (e.g. `AppName 0x1e4715 (AppName, pid: 55746)` -> `AppName`).
 */
export function normalizeThreadName(threadFmt: string): string {
  if (/main\s*thread/i.test(threadFmt)) return "Main Thread";
  if (/hermes/i.test(threadFmt) || /jsthread/i.test(threadFmt)) return "JS/Hermes";
  const shortMatch = threadFmt.match(/^(.+?)\s+0x/);
  if (shortMatch) return shortMatch[1];
  return threadFmt;
}
