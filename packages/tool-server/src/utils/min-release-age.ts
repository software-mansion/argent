import { exec } from "node:child_process";

/**
 * Detection of the machine's "minimum release age" supply-chain policy.
 *
 * Several package managers can refuse to install a package version until it has
 * been public for some minimum amount of time, so a freshly-published (possibly
 * compromised) version is not pulled in before anyone notices. When such a
 * policy is in effect, advertising an Argent update the moment it lands on npm
 * is pure noise — the user *cannot* install it yet, so the reminder repeats for
 * days until the version finally ages past the gate.
 *
 * This module computes the effective policy as a duration in milliseconds so
 * the update checker can hold back the reminder until the latest version is old
 * enough to actually be installable. `0` means "no policy / install immediately".
 *
 * Sources, by package manager (key name + native unit differ per PM):
 *   - npm   `min-release-age`     days     (npm >= 11.10)
 *   - pnpm  `minimumReleaseAge`   minutes  (pnpm >= 10.16)
 *   - yarn  `npmMinimalAgeGate`   minutes  (yarn berry >= 4.10)
 *   - bun   `minimumReleaseAge`   seconds  (bun >= 1.3, bunfig.toml only — no
 *                                          `config get`, so not auto-probed)
 *
 * Because the long-running tool-server has no reliable signal for *which* PM the
 * user installed Argent with, we probe every PM that is present and take the
 * **most restrictive** (largest) configured age. Erring toward over-waiting is
 * deliberate: a slightly late reminder is strictly better for the user than
 * nagging about a version their policy forbids installing.
 */

const PROBE_TIMEOUT_MS = 3_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Explicit override env var, expressed in whole days (accepts fractional). */
const OVERRIDE_ENV = "ARGENT_MIN_RELEASE_AGE_DAYS";

interface PmPolicyProbe {
  /** Package-manager binary to invoke (`<bin> config get <key>`). */
  bin: string;
  /** Config key holding the policy, in that PM's native spelling. */
  key: string;
  /** Convert the raw config value (in the PM's native unit) to milliseconds. */
  toMs: (raw: number) => number;
}

const PM_PROBES: readonly PmPolicyProbe[] = [
  { bin: "npm", key: "min-release-age", toMs: (days) => days * DAY_MS },
  { bin: "pnpm", key: "minimumReleaseAge", toMs: (min) => min * MINUTE_MS },
  { bin: "yarn", key: "npmMinimalAgeGate", toMs: (min) => min * MINUTE_MS },
];

/**
 * Parse the stdout of `<pm> config get <key>`. Package managers print
 * `undefined`, `null`, an empty string, or `Infinity` when the key is unset or
 * not understood by that version — all of which mean "no policy" here. Returns
 * a positive number, or `0` for anything that does not denote a finite, positive
 * value.
 */
export function parseConfigValue(stdout: string): number {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function probePm(probe: PmPolicyProbe): Promise<number> {
  return new Promise((resolve) => {
    // `exec` (shell) rather than `execFile` so PMs that ship as `.cmd`/`.ps1`
    // shims on Windows resolve via PATH. The command is built from compile-time
    // constants only — no caller input reaches the shell.
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
 * Resolve the effective minimum-release-age policy as milliseconds.
 *
 * `ARGENT_MIN_RELEASE_AGE_DAYS`, when set to a positive number, wins outright
 * and skips PM probing (lets users in locked-down/offline CI pin the value
 * without shelling out). Otherwise every supported PM is probed in parallel and
 * the largest configured age is returned. `0` means no policy is in effect.
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
