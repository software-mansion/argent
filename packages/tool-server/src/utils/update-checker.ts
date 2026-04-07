import https from "node:https";
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

/**
 * Parses a semver string "major.minor.patch" into numeric components.
 * Returns null for non-semver strings (pre-release tags, etc.).
 */
function parseSemver(v: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Returns true if `latest` is strictly greater than `current` by semver ordering.
 * Returns false for non-semver strings (pre-release, local dev versions).
 */
function isNewerVersion(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) return false;
  if (l[0] !== c[0]) return l[0] > c[0];
  if (l[1] !== c[1]) return l[1] > c[1];
  return l[2] > c[2];
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
  check();

  interval = setInterval(() => {
    check();
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
