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
  /** Whether a newer stable version exists on npm (pure version comparison). */
  updateAvailable: boolean;
  /**
   * Whether that newer version is actually installable *now* — i.e. it is newer
   * AND it has aged past the machine's minimum-release-age policy. The update
   * reminder is gated on this, not on `updateAvailable`, so users with a
   * package-age security policy are not nagged about a version they cannot yet
   * install. Equals `updateAvailable` when no policy is in effect.
   */
  updateInstallable: boolean;
  /** The latest version on npm, or `null` if not yet checked / check failed. */
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

interface LatestRelease {
  version: string;
  /** ISO 8601 publish time, or `null` if the registry omitted it. */
  publishedAt: string | null;
}

/**
 * Fetches the latest release of the package from the npm registry.
 *
 * We request the full packument (not the `/latest` manifest) because only the
 * packument carries the `time` map of version → publish timestamp, which the
 * minimum-release-age gate needs. Returns `null` on any failure — update checks
 * must never crash the server.
 */
async function fetchLatestRelease(): Promise<LatestRelease | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (value: LatestRelease | null) => {
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
          const latest = json["dist-tags"]?.latest;
          if (!latest) {
            safeResolve(null);
            return;
          }
          safeResolve({ version: latest, publishedAt: json.time?.[latest] ?? null });
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
  const release = await fetchLatestRelease();
  if (release === null) return; // network issue — keep previous state

  const minReleaseAgeMs = await detectMinReleaseAgeMs();
  const updateAvailable = isNewerVersion(release.version, currentVersion);
  const updateInstallable = updateAvailable && isOldEnough(release.publishedAt, minReleaseAgeMs);

  state = {
    updateAvailable,
    updateInstallable,
    latestVersion: release.version,
    latestPublishedAt: release.publishedAt,
    minReleaseAgeMs,
    currentVersion,
  };

  if (updateInstallable) {
    process.stderr.write(`[argent] Update available: ${currentVersion} -> ${release.version}\n`);
  } else if (updateAvailable && minReleaseAgeMs > 0) {
    // Available but held back by the machine's package-age policy — log once so
    // the silence is explainable, but do not surface a reminder to the agent.
    process.stderr.write(
      `[argent] Update ${currentVersion} -> ${release.version} is held by a minimum-release-age policy; ` +
        `reminder deferred until it ages past the gate.\n`
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
