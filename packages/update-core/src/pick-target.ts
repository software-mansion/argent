import semver from "semver";
import type { VersionAt } from "./registry";

function isStableUpgrade(version: string, current: string | null): boolean {
  if (!semver.valid(version) || semver.prerelease(version)) return false;
  if (current === null) return true;
  if (!semver.valid(current)) return false;
  return semver.gt(version, current);
}

// An unknown/unparseable publish time counts as too new: delay rather than nag.
function isOldEnough(publishedAt: string | null, minReleaseAgeMs: number): boolean {
  if (minReleaseAgeMs <= 0) return true;
  if (!publishedAt) return false;
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return false;
  return Date.now() - published >= minReleaseAgeMs;
}

/**
 * Newest stable version above `current` that also clears the release-age
 * policy. Under a policy every version is scanned, since the latest publish may
 * be held back while an older one is already eligible. `current === null` means
 * nothing installed, so any stable release qualifies.
 */
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
    // `times` also carries non-version keys ("created"/"modified").
    if (!semver.valid(version) || semver.prerelease(version)) continue;
    if (current !== null && !semver.gt(version, current)) continue;
    if (!isOldEnough(publishedAt, minReleaseAgeMs)) continue;
    if (best === null || semver.gt(version, best.version)) {
      best = { version, publishedAt };
    }
  }
  return best;
}
