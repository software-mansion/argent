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
  /** Whether a newer stable version exists on npm (latest tag vs. current). */
  updateAvailable: boolean;
  /**
   * Whether there is a newer version that is actually installable *now* — i.e.
   * a newer stable release that has also aged past the machine's
   * minimum-release-age policy. The update reminder is gated on this, not on
   * `updateAvailable`, so users with a package-age security policy are not
   * nagged about a version they cannot yet install. Equals `updateAvailable`
   * when no policy is in effect.
   */
  updateInstallable: boolean;
  /**
   * The version the reminder advertises: the newest stable release that is
   * newer than current AND clears the policy — i.e. what the package manager
   * would resolve to. This is NOT necessarily `latestVersion`: under a policy
   * the latest publish may be held back while an older-but-eligible version is
   * installable. `null` when nothing is installable.
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

/**
 * Whether `publishedAt` is far enough in the past to clear a `minReleaseAgeMs`
 * policy. With no policy (`<= 0`) everything passes. When a policy is in effect
 * but the publish time is unknown/unparseable, we conservatively report `false`
 * — better to delay the reminder than to nag about a version the policy may
 * still be holding back.
 */
function isOldEnough(publishedAt: string | null, minReleaseAgeMs: number): boolean {
  if (minReleaseAgeMs <= 0) return true;
  if (!publishedAt) return false;
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return false;
  return Date.now() - published >= minReleaseAgeMs;
}

interface VersionAt {
  version: string;
  /** ISO 8601 publish time, or `null` if the registry omitted it. */
  publishedAt: string | null;
}

/**
 * Pick the version the user could install *right now* — mirroring how a package
 * manager resolves under a minimum-release-age policy: the newest stable
 * release that is newer than `current` AND has aged past the gate.
 *
 * With no policy this is simply the latest tag (if newer). Under a policy we
 * scan every published version, because the latest publish may be held back
 * while an older-but-eligible version (e.g. the previous minor) is installable.
 * Returns `null` when nothing newer is installable.
 */
function pickInstallableTarget(
  latest: VersionAt,
  times: Record<string, string>,
  current: string,
  minReleaseAgeMs: number
): VersionAt | null {
  // No policy → the resolver installs the latest tag directly; publish times
  // are irrelevant (and may be absent), so don't require them.
  if (minReleaseAgeMs <= 0) {
    return isNewerVersion(latest.version, current) ? latest : null;
  }

  let best: VersionAt | null = null;
  for (const [version, publishedAt] of Object.entries(times)) {
    // `times` also carries non-version keys ("created"/"modified") — invalid
    // semver, so they fall out here along with prereleases.
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
  /** The `latest` dist-tag and its publish time. */
  latest: VersionAt;
  /** Map of version → ISO 8601 publish time (also includes created/modified). */
  times: Record<string, string>;
}

/**
 * Fetches the package's registry document from npm.
 *
 * We request the full packument (not the `/latest` manifest) because only the
 * packument carries the `time` map of version → publish timestamp, which the
 * minimum-release-age gate needs to find the newest *installable* version.
 * Returns `null` on any failure — update checks must never crash the server.
 */
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
    // A newer version exists but none is installable yet under the machine's
    // package-age policy — log once so the silence is explainable, but do not
    // surface a reminder to the agent.
    process.stderr.write(
      `[argent] Update ${currentVersion} -> ${info.latest.version} is held by a minimum-release-age policy; ` +
        `reminder deferred until an eligible version ages past the gate.\n`
    );
  }
}

/**
 * Start the update checker: runs an immediate check, then rechecks every 24h.
 * Safe to call once at startup. Returns a dispose function to clear the timer.
 *
 * When reminders are disabled via {@link areUpdateNotificationsDisabled}, this
 * is a no-op — no network request is made and the state stays at its default
 * (`updateInstallable: false`), so no note is ever attached.
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
