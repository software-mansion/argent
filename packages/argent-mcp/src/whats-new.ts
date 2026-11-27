import semver from "semver";
import {
  getWhatsNewSeenVersion,
  isFeatureEnabled,
  setWhatsNewSeenVersion,
} from "@argent/configuration-core";
import { RELEASE_HIGHLIGHTS } from "./release-highlights.js";

const MAX_HIGHLIGHTS = 5;

export function whatsNewEnabled(): boolean {
  return isFeatureEnabled("whats-new");
}

function isNewerThanSeen(current: string, seen: string | null): boolean {
  if (!semver.valid(current)) return false;
  const previous = semver.valid(seen);
  return previous === null || semver.gt(current, previous);
}

/**
 * Highlights of the releases after `seen` up to `current`, newest first. Without
 * a recorded version only the current release counts, since the previous one is
 * unknown.
 */
export function highlightsSince(
  seen: string | null,
  current: string,
  releases: Readonly<Record<string, readonly string[]>> = RELEASE_HIGHLIGHTS
): string[] {
  if (!semver.valid(current)) return [];
  const previous = semver.valid(seen);
  const isNewRelease = (version: string): boolean =>
    previous ? semver.gt(version, previous) : version === current;
  return Object.keys(releases)
    .filter((version) => semver.lte(version, current) && isNewRelease(version))
    .sort(semver.rcompare)
    .flatMap((version) => releases[version]!)
    .slice(0, MAX_HIGHLIGHTS);
}

export function formatWhatsNewNote(version: string, highlights: readonly string[]): string {
  return [
    `Argent was updated to v${version} before this session. Briefly tell the user what is new, then continue:`,
    ...highlights.map((highlight) => `- ${highlight}`),
  ].join("\n");
}

/**
 * The note for the first tool result after an update, or undefined. Records the
 * current version, so every later call, in this process or another, gets nothing.
 * The record only moves forward: local-mode repos on older versions share it.
 */
export function takeWhatsNewNote(current: string): string | undefined {
  let seen = getWhatsNewSeenVersion();
  while (isNewerThanSeen(current, seen)) {
    if (setWhatsNewSeenVersion(current, { ifSeen: seen })) {
      const highlights = highlightsSince(seen, current);
      return highlights.length > 0 ? formatWhatsNewNote(current, highlights) : undefined;
    }
    seen = getWhatsNewSeenVersion();
  }
  return undefined;
}
