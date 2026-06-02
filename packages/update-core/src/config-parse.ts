// Pure parsing of `<pm> config get <key>` stdout into milliseconds. No I/O —
// safe to unit-test in isolation. Shared by the installer (which knows the
// package manager it is about to run) and the tool-server update checker
// (which probes every package manager because it cannot know which was used).

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

function trimConfigValue(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Parse `<pm> config get <key>` stdout to a positive number, else 0 (unset). */
export function parseConfigValue(stdout: string): number {
  const value = trimConfigValue(stdout);
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Parse npm's effective `before` cutoff into an equivalent age in ms.
 * Returns 0 when unset, invalid, or in the future (no effective gate).
 */
export function parseBeforeAgeMs(stdout: string, now = Date.now()): number {
  const value = trimConfigValue(stdout);
  if (!value) return 0;

  const candidates = [value, value.replace(/\s+\([^)]*\)$/, "")];
  for (const candidate of candidates) {
    const ts = Date.parse(candidate);
    if (!Number.isNaN(ts)) {
      return ts < now ? now - ts : 0;
    }
  }
  return 0;
}

/**
 * Parse Yarn's `npmMinimalAgeGate` into ms. A bare number is interpreted as
 * minutes; a `<amount><unit>` string (ms/s/m/h/d/w) uses that unit. Returns 0
 * when unset or unparseable.
 */
export function parseYarnAgeGateMs(stdout: string): number {
  const value = trimConfigValue(stdout);
  if (!value) return 0;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric * MINUTE_MS;
  }

  const match = value.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
  if (!match) return 0;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  switch (match[2].toLowerCase()) {
    case "ms":
      return amount;
    case "s":
      return amount * SECOND_MS;
    case "m":
      return amount * MINUTE_MS;
    case "h":
      return amount * 60 * MINUTE_MS;
    case "d":
      return amount * DAY_MS;
    case "w":
      return amount * 7 * DAY_MS;
    default:
      return 0;
  }
}
