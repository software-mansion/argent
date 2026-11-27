import {
  detectMinReleaseAgeMsForPm,
  fetchRegistryInfo,
  pickInstallableTarget,
} from "@argent/update-core";
import { NPM_REGISTRY, PACKAGE_NAME } from "./constants.js";
import type { PackageManager } from "./utils.js";

interface ResolvedUpdateTarget {
  latestVersion: string;
  latestPublishedAt: string | null;
  /** Newest stable upgrade installable now under the release-age policy. */
  targetVersion: string | null;
  minReleaseAgeMs: number;
}

/**
 * Resolve the version `argent update` should install for `pm`: the newest
 * stable release newer than `current` that also clears the minimum-release-age
 * policy `pm` applies in `cwd`, where the install runs. Returns null when the
 * registry lookup fails.
 */
export async function resolveInstallableUpdateTarget(
  pm: PackageManager,
  current: string | null,
  cwd?: string,
  candidate?: string
): Promise<ResolvedUpdateTarget | null> {
  const info = await fetchRegistryInfo(`${NPM_REGISTRY}/${PACKAGE_NAME}`);
  if (info === null) return null;

  const minReleaseAgeMs = await detectMinReleaseAgeMsForPm(pm, cwd);
  // A background check may have selected an older release under a stricter
  // policy. Check that exact release against the installing manager's policy.
  let { latest, times } = info;
  if (candidate) {
    const publishedAt = times[candidate] ?? null;
    latest = { version: candidate, publishedAt };
    times = publishedAt ? { [candidate]: publishedAt } : {};
    if (candidate !== info.latest.version && !publishedAt) return null;
  }
  const target = pickInstallableTarget(latest, times, current, minReleaseAgeMs);

  return {
    latestVersion: info.latest.version,
    latestPublishedAt: info.latest.publishedAt,
    targetVersion: target?.version ?? null,
    minReleaseAgeMs,
  };
}
