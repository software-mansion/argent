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
// duration in ms (0 = no policy).

const PROBE_TIMEOUT_MS = 3_000;
const OVERRIDE_ENV = "ARGENT_MIN_RELEASE_AGE_DAYS";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

interface PmPolicyProbe {
  command: string;
  /** Parse the PM's `config get` stdout into milliseconds. */
  parse: (stdout: string) => number;
}

// bun has no `config get`, so only the ARGENT_MIN_RELEASE_AGE_DAYS override
// covers it.
const PM_PROBES: Partial<Record<PackageManagerName, PmPolicyProbe>> = {
  // Probe `before`: that is the effective cutoff npm's resolver applies.
  npm: { command: "npm config get before", parse: parseBeforeAgeMs },
  pnpm: {
    command: "pnpm config get minimumReleaseAge",
    parse: (stdout) => parseConfigValue(stdout) * MINUTE_MS,
  },
  yarn: { command: "yarn config get npmMinimalAgeGate", parse: parseYarnAgeGateMs },
};

// Override in ms; null when unset, meaning the caller should probe.
function overrideMs(): number | null {
  const override = process.env[OVERRIDE_ENV];
  if (override === undefined) return null;
  const days = Number(override);
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : 0;
}

function probe(p: PmPolicyProbe): Promise<number> {
  return new Promise((resolve) => {
    // Shell (not execFile) so Windows `.cmd`/`.ps1` shims resolve via PATH;
    // commands are compile-time constants, never caller input.
    exec(p.command, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(0); // not installed or errored — no policy
        return;
      }
      resolve(p.parse(stdout));
    });
  });
}

/**
 * Minimum-release-age policy in ms (0 = none) for a known package manager.
 * Use when a specific PM is about to run (e.g. `argent update`).
 */
export async function detectMinReleaseAgeMsForPm(pm: PackageManagerName): Promise<number> {
  const override = overrideMs();
  if (override !== null) return override;

  const p = PM_PROBES[pm];
  return p ? probe(p) : 0;
}

/**
 * Minimum-release-age policy in ms (0 = none) when the package manager is
 * unknown: the most restrictive value across all PMs. The
 * ARGENT_MIN_RELEASE_AGE_DAYS override wins and skips probing.
 */
export async function detectMinReleaseAgeMs(): Promise<number> {
  const override = overrideMs();
  if (override !== null) return override;

  const ages = await Promise.all(Object.values(PM_PROBES).map(probe));
  return ages.reduce((max, ms) => Math.max(max, ms), 0);
}
