/**
 * Canonical display name for an Instruments thread descriptor, dropping the hex
 * id + pid suffix (`AppName 0x1e4715 (AppName, pid: 55746)` -> `AppName`).
 */
export function normalizeThreadName(threadFmt: string): string {
  if (/main\s*thread/i.test(threadFmt)) return "Main Thread";
  if (/hermes/i.test(threadFmt) || /jsthread/i.test(threadFmt)) return "JS/Hermes";
  const shortMatch = threadFmt.match(/^(.+?)\s+0x/);
  if (shortMatch) return shortMatch[1];
  return threadFmt;
}
