import semver from "semver";
import { getWhatsNewSeenVersion, setWhatsNewSeenVersion } from "@argent/configuration-core";
import { RELEASE_HIGHLIGHTS } from "./release-highlights.js";

const MAX_HIGHLIGHTS = 5;

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
    `Argent was updated to v${version}. Tell the user what is new in one sentence or a short list, then continue the task:`,
    ...highlights.map((highlight) => `- ${highlight}`),
  ].join("\n");
}

/**
 * The note for the first tool result after an update, or undefined. Records the
 * current version, so every later call, in this process or another, gets nothing.
 */
export function takeWhatsNewNote(current: string): string | undefined {
  const seen = getWhatsNewSeenVersion();
  if (seen === current || !semver.valid(current)) return undefined;
  setWhatsNewSeenVersion(current);
  const highlights = highlightsSince(seen, current);
  return highlights.length > 0 ? formatWhatsNewNote(current, highlights) : undefined;
}
