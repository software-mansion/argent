import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import semver from "semver";
import { version as currentVersion } from "../../package.json";
import {
  detectMinReleaseAgeMs,
  fetchRegistryInfo,
  pickInstallableTarget,
} from "@argent/update-core";

const PACKAGE_NAME = "@swmansion/argent";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
const CHECK_INTERVAL_MS = 60 * 60 * 1000 * 24;

function getSuppressionFilePath(): string {
  return path.join(os.homedir(), ".argent", "update-suppression.json");
}

function loadSuppressUntil(): number {
  try {
    const raw = fs.readFileSync(getSuppressionFilePath(), "utf8");
    const parsed = JSON.parse(raw) as { suppressUntil?: unknown };
    const value = parsed.suppressUntil;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function persistSuppressUntil(value: number): void {
  const filePath = getSuppressionFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ suppressUntil: value }));
}

export interface UpdateState {
  /** A newer stable version exists on npm (`latest` tag vs. current). */
  updateAvailable: boolean;
  /**
   * Newer AND aged past the minimum-release-age policy. The reminder gates on
   * this, not `updateAvailable`. Equal to `updateAvailable` with no policy.
   */
  updateInstallable: boolean;
  /**
   * The version the reminder advertises. Can lag `latestVersion`: the newest
   * publish may be held back while an older version is already eligible.
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
let suppressUntil = loadSuppressUntil();

export function getUpdateState(): Readonly<UpdateState> {
  return { ...state };
}

export function isUpdateNoteSuppressed(): boolean {
  return Date.now() < suppressUntil;
}

/**
 * Suppress update notifications for `durationMs`, persisted across restarts.
 * @throws if the suppression file cannot be written.
 */
export function suppressUpdateNote(durationMs: number): void {
  const next = Date.now() + durationMs;
  persistSuppressUntil(next);
  suppressUntil = next;
}

function isNewerVersion(latest: string, current: string): boolean {
  if (!semver.valid(latest) || !semver.valid(current)) return false;
  // Only stable releases are ever offered. A prerelease `current` still gets
  // flagged (0.6.0-next.0 → 0.6.0): semver.gt ranks stable above its prereleases.
  if (semver.prerelease(latest)) return false;
  return semver.gt(latest, current);
}

async function check(): Promise<void> {
  const info = await fetchRegistryInfo(REGISTRY_URL);
  if (info === null) return;

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
    process.stderr.write(
      `[argent] Update ${currentVersion} -> ${info.latest.version} is held by a minimum-release-age policy; ` +
        `reminder deferred until an eligible version ages past the gate.\n`
    );
  }
}

/** Checks immediately, then every 24h. Returns a dispose fn for the timer. */
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
  interval.unref();

  return {
    dispose() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
