import { exec } from "node:child_process";
import {
  DAY_MS,
  MINUTE_MS,
  parseBeforeAgeMs,
  parseConfigValue,
  parseYarnAgeGateMs,
} from "./config-parse";

// Detects the machine's "minimum release age" policy — package managers that
// refuse to install a version until it has been public for some time — as a
// duration in ms (0 = no policy). Lets callers hold back updates/reminders for
// versions the user cannot install yet.

const PROBE_TIMEOUT_MS = 3_000;
const OVERRIDE_ENV = "ARGENT_MIN_RELEASE_AGE_DAYS";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

interface PmPolicyProbe {
  command: string;
  /** Convert the raw config value (in the PM's native unit) to milliseconds. */
  parse: (stdout: string) => number;
}

// bun also supports this (minimumReleaseAge, seconds) but has no `config get`,
// so it is covered by the ARGENT_MIN_RELEASE_AGE_DAYS override instead.
const PM_PROBES: Partial<Record<PackageManagerName, PmPolicyProbe>> = {
  // npm flattens `min-release-age` to an effective `before` cutoff, and some
  // npm 11.x builds report `min-release-age=null` even while the policy is
  // active. Probe `before`, which is what the resolver actually uses.
  npm: { command: "npm config get before", parse: parseBeforeAgeMs },
  pnpm: {
    command: "pnpm config get minimumReleaseAge",
    parse: (stdout) => parseConfigValue(stdout) * MINUTE_MS,
  },
  yarn: { command: "yarn config get npmMinimalAgeGate", parse: parseYarnAgeGateMs },
};

// The ARGENT_MIN_RELEASE_AGE_DAYS override, in ms, or null when unset (probe).
function overrideMs(): number | null {
  const override = process.env[OVERRIDE_ENV];
  if (override === undefined) return null;
  const days = Number(override);
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : 0;
}

function probe(p: PmPolicyProbe): Promise<number> {
  return new Promise((resolve) => {
    // Shell (not execFile) so Windows `.cmd`/`.ps1` shims resolve via PATH;
    // command is compile-time constants only, no caller input.
    exec(p.command, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(0); // PM not installed / errored — treat as no policy.
        return;
      }
      resolve(p.parse(stdout));
    });
  });
}

/**
 * Minimum-release-age policy in ms (0 = none) for a known package manager.
 * Use this when the caller is about to run a specific PM (e.g. `argent update`).
 */
export async function detectMinReleaseAgeMsForPm(pm: PackageManagerName): Promise<number> {
  const override = overrideMs();
  if (override !== null) return override;

  const p = PM_PROBES[pm];
  return p ? probe(p) : 0;
}

/**
 * Effective minimum-release-age policy in ms (0 = none) when the package
 * manager is unknown: probe every PM and take the most restrictive value. The
 * ARGENT_MIN_RELEASE_AGE_DAYS override wins and skips probing.
 */
export async function detectMinReleaseAgeMs(): Promise<number> {
  const override = overrideMs();
  if (override !== null) return override;

  const ages = await Promise.all(Object.values(PM_PROBES).map(probe));
  return ages.reduce((max, ms) => Math.max(max, ms), 0);
}
