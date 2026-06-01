import https from "node:https";
import semver from "semver";
import { version as currentVersion } from "../../package.json";
import { detectMinReleaseAgeMs } from "./min-release-age";

const PACKAGE_NAME = "@swmansion/argent";
const CHECK_INTERVAL_MS = 60 * 60 * 1000 * 24; // 24 hour
const REQUEST_TIMEOUT_MS = 10_000;

/** Set truthy to silence the update reminder entirely (no check, no note). */
const DISABLE_ENV = "ARGENT_DISABLE_UPDATE_NOTIFICATIONS";

export interface UpdateState {
  /** A newer stable version exists on npm (latest tag vs. current). */
  updateAvailable: boolean;
  /**
   * A newer version is installable now — newer AND aged past the
   * minimum-release-age policy. The reminder gates on this, not
   * `updateAvailable`. Equals `updateAvailable` when no policy is in effect.
   */
  updateInstallable: boolean;
  /**
   * The version the reminder advertises — the newest stable release the
   * resolver would install under the policy. Not necessarily `latestVersion`:
   * the latest publish may be held back while an older version is eligible.
   */
  installableVersion: string | null;
  /** The latest version on npm (the `latest` dist-tag), or `null` if unknown. */
  latestVersion: string | null;
  /** ISO 8601 publish time of `latestVersion`, or `null` if unknown. */
  latestPublishedAt: string | null;
  /** Effective minimum-release-age policy in ms (`0` = no policy). */
  minReleaseAgeMs: number;
  /** The currently running version. */
  currentVersion: string;
}

let state: UpdateState = {
  updateAvailable: false,
  updateInstallable: false,
  installableVersion: null,
  latestVersion: null,
  latestPublishedAt: null,
  minReleaseAgeMs: 0,
  currentVersion,
};

let interval: ReturnType<typeof setInterval> | null = null;
let suppressUntil = 0;

/** True when update reminders are disabled via the environment. */
export function areUpdateNotificationsDisabled(): boolean {
  const v = process.env[DISABLE_ENV];
  return v === "1" || v === "true";
}

/** Returns the current update state (read-only snapshot). */
export function getUpdateState(): Readonly<UpdateState> {
  return { ...state };
}

/** Returns true if the update notification is currently suppressed. */
export function isUpdateNoteSuppressed(): boolean {
  return Date.now() < suppressUntil;
}

/** Suppress update notifications for the given duration (milliseconds). */
export function suppressUpdateNote(durationMs: number): void {
  suppressUntil = Date.now() + durationMs;
}

function isNewerVersion(latest: string, current: string): boolean {
  if (!semver.valid(latest) || !semver.valid(current)) return false;
  // Never push prereleases — only notify when a stable version is newer.
  // This still flags correctly when `current` is a prerelease (e.g. 0.6.0-next.0
  // → 0.6.0) because semver.gt treats stable as greater than its prereleases.
  if (semver.prerelease(latest)) return false;
  return semver.gt(latest, current);
}

// No policy → everything passes. Under a policy, an unknown/unparseable
// publish time conservatively returns false (delay rather than nag).
function isOldEnough(publishedAt: string | null, minReleaseAgeMs: number): boolean {
  if (minReleaseAgeMs <= 0) return true;
  if (!publishedAt) return false;
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return false;
  return Date.now() - published >= minReleaseAgeMs;
}

interface VersionAt {
  version: string;
  publishedAt: string | null;
}

/**
 * The newest stable version newer than `current` that the resolver could
 * install now — i.e. that also clears the policy. With no policy this is just
 * the latest tag; under one we scan all versions, since the latest publish may
 * be held while an older version is eligible. `null` when nothing is installable.
 */
function pickInstallableTarget(
  latest: VersionAt,
  times: Record<string, string>,
  current: string,
  minReleaseAgeMs: number
): VersionAt | null {
  if (minReleaseAgeMs <= 0) {
    return isNewerVersion(latest.version, current) ? latest : null;
  }

  let best: VersionAt | null = null;
  for (const [version, publishedAt] of Object.entries(times)) {
    // `times` also carries non-version keys ("created"/"modified") — filtered as invalid semver.
    if (!semver.valid(version) || semver.prerelease(version)) continue;
    if (!semver.gt(version, current)) continue;
    if (!isOldEnough(publishedAt, minReleaseAgeMs)) continue;
    if (best === null || semver.gt(version, best.version)) {
      best = { version, publishedAt };
    }
  }
  return best;
}

interface RegistryInfo {
  latest: VersionAt;
  /** version → ISO 8601 publish time (also includes created/modified). */
  times: Record<string, string>;
}

// Fetch the full packument (not /latest) — only it carries the `time` map the
// release-age gate needs. Returns null on any failure (never crashes the server).
async function fetchRegistryInfo(): Promise<RegistryInfo | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (value: RegistryInfo | null) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    const url = `https://registry.npmjs.org/${PACKAGE_NAME}`;

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

/** Run a single check and update the runtime state. */
async function check(): Promise<void> {
  const info = await fetchRegistryInfo();
  if (info === null) return; // network issue — keep previous state

  const minReleaseAgeMs = await detectMinReleaseAgeMs();
  const updateAvailable = isNewerVersion(info.latest.version, currentVersion);
  const target = pickInstallableTarget(info.latest, info.times, currentVersion, minReleaseAgeMs);

  state = {
    updateAvailable,
    updateInstallable: target !== null,
    installableVersion: target?.version ?? null,
    latestVersion: info.latest.version,
    latestPublishedAt: info.latest.publishedAt,
    minReleaseAgeMs,
    currentVersion,
  };

  if (target !== null) {
    process.stderr.write(`[argent] Update available: ${currentVersion} -> ${target.version}\n`);
  } else if (updateAvailable && minReleaseAgeMs > 0) {
    // Newer version exists but none is installable yet under the policy — log
    // once to explain the silence; no reminder is surfaced to the agent.
    process.stderr.write(
      `[argent] Update ${currentVersion} -> ${info.latest.version} is held by a minimum-release-age policy; ` +
        `reminder deferred until an eligible version ages past the gate.\n`
    );
  }
}

/**
 * Run an immediate check, then recheck every 24h. Returns a dispose fn for the
 * timer. No-op when reminders are disabled (no request, state stays default).
 */
export function startUpdateChecker(): { dispose(): void } {
  if (areUpdateNotificationsDisabled()) {
    return { dispose() {} };
  }

  // Clear any leaked interval from a prior call.
  if (interval) {
    clearInterval(interval);
  }

  // Fire-and-forget initial check — don't block startup.
  check().catch(() => {});

  interval = setInterval(() => {
    check().catch(() => {});
  }, CHECK_INTERVAL_MS);
  interval.unref(); // don't keep the process alive for update checks

  return {
    dispose() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
