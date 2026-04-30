import https from "node:https";
import semver from "semver";
import { version as currentVersion } from "../../package.json";

const PACKAGE_NAME = "@swmansion/argent";
const CHECK_INTERVAL_MS = 60 * 60 * 1000 * 24; // 24 hour
const REQUEST_TIMEOUT_MS = 10_000;

export interface UpdateState {
  /** Whether a newer version is available on npm. */
  updateAvailable: boolean;
  /** The latest version on npm, or `null` if not yet checked / check failed. */
  latestVersion: string | null;
  /** The currently running version. */
  currentVersion: string;
}

let state: UpdateState = {
  updateAvailable: false,
  latestVersion: null,
  currentVersion,
};

let interval: ReturnType<typeof setInterval> | null = null;
let suppressUntil = 0;

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
 * Fetches the latest version of the package from the npm registry.
 * Returns `null` on any failure — update checks must never crash the server.
 */
async function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (value: string | null) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    const url = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

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
          const json = JSON.parse(body) as { version?: string };
          safeResolve(json.version ?? null);
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
  const latest = await fetchLatestVersion();
  if (latest === null) return; // network issue — keep previous state

  state = {
    updateAvailable: isNewerVersion(latest, currentVersion),
    latestVersion: latest,
    currentVersion,
  };

  if (state.updateAvailable) {
    process.stderr.write(`[argent] Update available: ${currentVersion} -> ${latest}\n`);
  }
}

/**
 * Start the update checker: runs an immediate check, then rechecks every hour.
 * Safe to call once at startup. Returns a dispose function to clear the timer.
 */
export function startUpdateChecker(): { dispose(): void } {
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
