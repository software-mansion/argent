import {
  detectMinReleaseAgeMsForPm,
  fetchRegistryInfo,
  pickInstallableTarget,
} from "@argent/update-core";
import { NPM_REGISTRY, PACKAGE_NAME } from "./constants.js";
import type { PackageManager } from "./utils.js";

export interface ResolvedUpdateTarget {
  latestVersion: string;
  latestPublishedAt: string | null;
  /** Newest stable version installable now under the release-age policy, or null. */
  targetVersion: string | null;
  minReleaseAgeMs: number;
}

/**
 * Resolve the version `argent update` should install for `pm`: the newest
 * stable release that is both newer than `current` and past the machine's
 * minimum-release-age policy. Returns null if the registry is unreachable.
 */
export async function resolveInstallableUpdateTarget(
  pm: PackageManager,
  current: string | null
): Promise<ResolvedUpdateTarget | null> {
  const info = await fetchRegistryInfo(`${NPM_REGISTRY}/${PACKAGE_NAME}`);
  if (info === null) return null;

  const minReleaseAgeMs = await detectMinReleaseAgeMsForPm(pm);
  const target = pickInstallableTarget(info.latest, info.times, current, minReleaseAgeMs);

  return {
    latestVersion: info.latest.version,
    latestPublishedAt: info.latest.publishedAt,
    targetVersion: target?.version ?? null,
    minReleaseAgeMs,
  };
}
