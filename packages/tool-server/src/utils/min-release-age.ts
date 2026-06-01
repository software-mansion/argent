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
  bin: string;
  key: string;
  /** Convert the raw config value (in the PM's native unit) to milliseconds. */
  toMs: (raw: number) => number;
}

// bun also supports this (minimumReleaseAge, seconds) but has no `config get`,
// so it is covered by the ARGENT_MIN_RELEASE_AGE_DAYS override instead.
const PM_PROBES: readonly PmPolicyProbe[] = [
  { bin: "npm", key: "min-release-age", toMs: (days) => days * DAY_MS },
  { bin: "pnpm", key: "minimumReleaseAge", toMs: (min) => min * MINUTE_MS },
  { bin: "yarn", key: "npmMinimalAgeGate", toMs: (min) => min * MINUTE_MS },
];

/** Parse `<pm> config get <key>` stdout to a positive number, else 0 (unset). */
export function parseConfigValue(stdout: string): number {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function probePm(probe: PmPolicyProbe): Promise<number> {
  return new Promise((resolve) => {
    // Shell (not execFile) so Windows `.cmd`/`.ps1` shims resolve via PATH;
    // command is compile-time constants only, no caller input.
    exec(
      `${probe.bin} config get ${probe.key}`,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(0); // PM not installed / errored — treat as no policy.
          return;
        }
        const raw = parseConfigValue(stdout);
        resolve(raw > 0 ? probe.toMs(raw) : 0);
      }
    );
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
