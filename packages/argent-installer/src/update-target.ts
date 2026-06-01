import { exec } from "node:child_process";
import https from "node:https";
import semver from "semver";
import { NPM_REGISTRY, PACKAGE_NAME } from "./constants.js";
import type { PackageManager } from "./utils.js";

const REQUEST_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;

const OVERRIDE_ENV = "ARGENT_MIN_RELEASE_AGE_DAYS";

export interface VersionAt {
  version: string;
  publishedAt: string | null;
}

interface RegistryInfo {
  latest: VersionAt;
  /** version → ISO 8601 publish time (also includes created/modified). */
  times: Record<string, string>;
}

export interface ResolvedUpdateTarget {
  latestVersion: string;
  latestPublishedAt: string | null;
  targetVersion: string | null;
  minReleaseAgeMs: number;
}

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

function parseNumericConfigValue(stdout: string): number {
  const value = trimConfigValue(stdout);
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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

function probe(command: string, parse: (stdout: string) => number): Promise<number> {
  return new Promise((resolve) => {
    exec(command, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(0);
        return;
      }
      resolve(parse(stdout));
    });
  });
}

export async function detectMinReleaseAgeMs(pm: PackageManager): Promise<number> {
  const override = process.env[OVERRIDE_ENV];
  if (override !== undefined) {
    const days = Number(override);
    return Number.isFinite(days) && days > 0 ? days * DAY_MS : 0;
  }

  switch (pm) {
    case "npm":
      return probe("npm config get before", parseBeforeAgeMs);
    case "pnpm":
      return probe(
        "pnpm config get minimumReleaseAge",
        (stdout) => parseNumericConfigValue(stdout) * MINUTE_MS
      );
    case "yarn":
      return probe("yarn config get npmMinimalAgeGate", parseYarnAgeGateMs);
    default:
      return 0;
  }
}

function isStableUpgrade(version: string, current: string | null): boolean {
  if (!semver.valid(version) || semver.prerelease(version)) return false;
  if (current === null) return true;
  if (!semver.valid(current)) return false;
  return semver.gt(version, current);
}

function isOldEnough(publishedAt: string | null, minReleaseAgeMs: number): boolean {
  if (minReleaseAgeMs <= 0) return true;
  if (!publishedAt) return false;
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return false;
  return Date.now() - published >= minReleaseAgeMs;
}

export function pickInstallableTarget(
  latest: VersionAt,
  times: Record<string, string>,
  current: string | null,
  minReleaseAgeMs: number
): VersionAt | null {
  if (minReleaseAgeMs <= 0) {
    return isStableUpgrade(latest.version, current) ? latest : null;
  }

  let best: VersionAt | null = null;
  for (const [version, publishedAt] of Object.entries(times)) {
    if (!semver.valid(version) || semver.prerelease(version)) continue;
    if (current !== null && !semver.gt(version, current)) continue;
    if (!isOldEnough(publishedAt, minReleaseAgeMs)) continue;
    if (best === null || semver.gt(version, best.version)) {
      best = { version, publishedAt };
    }
  }
  return best;
}

async function fetchRegistryInfo(): Promise<RegistryInfo | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (value: RegistryInfo | null) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    const url = `${NPM_REGISTRY}/${PACKAGE_NAME}`;

    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        safeResolve(null);
        return;
      }

      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(body) as {
            "dist-tags"?: { latest?: string };
            "time"?: Record<string, string>;
          };
          const latestVersion = json["dist-tags"]?.latest;
          if (!latestVersion) {
            safeResolve(null);
            return;
          }
          const times = json.time ?? {};
          safeResolve({
            latest: { version: latestVersion, publishedAt: times[latestVersion] ?? null },
            times,
          });
        } catch {
          safeResolve(null);
        }
      });
      res.on("error", () => safeResolve(null));
    });

    req.on("error", () => safeResolve(null));
    req.on("timeout", () => {
      req.destroy();
      safeResolve(null);
    });
  });
}

export async function resolveInstallableUpdateTarget(
  pm: PackageManager,
  current: string | null
): Promise<ResolvedUpdateTarget | null> {
  const info = await fetchRegistryInfo();
  if (info === null) return null;

  const minReleaseAgeMs = await detectMinReleaseAgeMs(pm);
  const target = pickInstallableTarget(info.latest, info.times, current, minReleaseAgeMs);

  return {
    latestVersion: info.latest.version,
    latestPublishedAt: info.latest.publishedAt,
    targetVersion: target?.version ?? null,
    minReleaseAgeMs,
  };
}
