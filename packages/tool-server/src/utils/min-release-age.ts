import { exec } from "node:child_process";

// Detects the machine's "minimum release age" policy — package managers that
// refuse to install a version until it has been public for some time — as a
// duration in ms (0 = no policy). Lets the update checker hold back reminders
// for versions the user cannot install yet.

const PROBE_TIMEOUT_MS = 3_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const OVERRIDE_ENV = "ARGENT_MIN_RELEASE_AGE_DAYS";

interface PmPolicyProbe {
  command: string;
  /** Convert the raw config value (in the PM's native unit) to milliseconds. */
  parse: (stdout: string) => number;
}

// bun also supports this (minimumReleaseAge, seconds) but has no `config get`,
// so it is covered by the ARGENT_MIN_RELEASE_AGE_DAYS override instead.
const PM_PROBES: readonly PmPolicyProbe[] = [
  // npm flattens `min-release-age` to an effective `before` cutoff, and some
  // npm 11.x builds report `min-release-age=null` even while the policy is
  // active. Probe `before`, which is what the resolver actually uses.
  { command: "npm config get before", parse: parseBeforeConfigValue },
  {
    command: "pnpm config get minimumReleaseAge",
    parse: (stdout) => parseConfigValue(stdout) * MINUTE_MS,
  },
  {
    command: "yarn config get npmMinimalAgeGate",
    parse: (stdout) => parseConfigValue(stdout) * MINUTE_MS,
  },
];

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
export function parseBeforeConfigValue(stdout: string, now = Date.now()): number {
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

function probePm(probe: PmPolicyProbe): Promise<number> {
  return new Promise((resolve) => {
    // Shell (not execFile) so Windows `.cmd`/`.ps1` shims resolve via PATH;
    // command is compile-time constants only, no caller input.
    exec(probe.command, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(0); // PM not installed / errored — treat as no policy.
        return;
      }
      resolve(probe.parse(stdout));
    });
  });
}

/**
 * Effective minimum-release-age policy in ms (0 = none). The
 * ARGENT_MIN_RELEASE_AGE_DAYS override wins; otherwise probe every PM and take
 * the most restrictive value, since the server can't know which PM was used.
 */
export async function detectMinReleaseAgeMs(): Promise<number> {
  const override = process.env[OVERRIDE_ENV];
  if (override !== undefined) {
    const days = Number(override);
    return Number.isFinite(days) && days > 0 ? days * DAY_MS : 0;
  }

  const ages = await Promise.all(PM_PROBES.map(probePm));
  return ages.reduce((max, ms) => Math.max(max, ms), 0);
}
