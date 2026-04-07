import https from "node:https";
import { version as currentVersion } from "../../package.json";

const PACKAGE_NAME = "@argent/tool-server";
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
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

/** Returns the current update state (read-only snapshot). */
export function getUpdateState(): Readonly<UpdateState> {
  return { ...state };
}

/**
 * Fetches the latest version of the package from the npm registry.
 * Returns `null` on any failure — update checks must never crash the server.
 */
async function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
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
          resolve(json.version ?? null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Run a single check and update the runtime state. */
async function check(): Promise<void> {
  const latest = await fetchLatestVersion();
  if (latest === null) return; // network issue — keep previous state

  state = {
    updateAvailable: latest !== currentVersion,
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
