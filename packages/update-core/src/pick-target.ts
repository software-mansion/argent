import semver from "semver";
import type { VersionAt } from "./registry";

function isStableUpgrade(version: string, current: string | null): boolean {
  if (!semver.valid(version) || semver.prerelease(version)) return false;
  if (current === null) return true;
  if (!semver.valid(current)) return false;
  return semver.gt(version, current);
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

/**
 * The newest stable version newer than `current` that the resolver could
 * install now — i.e. one that also clears the policy. With no policy this is
 * just the latest tag; under one we scan all versions, since the latest publish
 * may be held back while an older version is already eligible. `current === null`
 * means "nothing installed", so any stable release qualifies. Returns null when
 * nothing is installable.
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
    // `times` also carries non-version keys ("created"/"modified") — filtered as invalid semver.
    if (!semver.valid(version) || semver.prerelease(version)) continue;
    if (current !== null && !semver.gt(version, current)) continue;
    if (!isOldEnough(publishedAt, minReleaseAgeMs)) continue;
    if (best === null || semver.gt(version, best.version)) {
      best = { version, publishedAt };
    }
  }
  return best;
}
