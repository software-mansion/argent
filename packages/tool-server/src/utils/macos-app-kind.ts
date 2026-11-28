import * as fs from "node:fs";
import * as path from "node:path";
import { argentHomeDir } from "@argent/configuration-core";

/**
 * The two kinds of native Mac app. A Mac Catalyst app (`catalyst`) is an iPad
 * (UIKit) app built for the Mac. It has the same `macos-app-<bundle id>` id and
 * the same platform as an AppKit app (`app`), but its UIKit views are not in
 * its AppKit view tree, so the tools that read that tree refuse it.
 */
export type MacosAppKind = "app" | "catalyst";

/** `~/.argent/macos-apps.json`: the record of each app argent started (macos-apps.ts). */
export function trackedMacosAppsFile(): string {
  return path.join(argentHomeDir(), "macos-apps.json");
}

/**
 * The file as last parsed, the bundle ids it records as Mac Catalyst apps, and
 * the identifierForVendor of each Mac Catalyst app whose library reported one.
 */
let parsed: {
  file: string;
  ino: number;
  mtimeMs: number;
  size: number;
  catalyst: ReadonlySet<string>;
  vendorIds: ReadonlyMap<string, string>;
} | null = null;

/** The file as {@link parsed} holds it, parsed again only after it changed. Throws when unreadable. */
function trackedRecords(): NonNullable<typeof parsed> {
  const file = trackedMacosAppsFile();
  const { ino, mtimeMs, size } = fs.statSync(file);
  if (
    parsed?.file !== file ||
    parsed.ino !== ino ||
    parsed.mtimeMs !== mtimeMs ||
    parsed.size !== size
  ) {
    const records: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const catalyst = new Set<string>();
    const vendorIds = new Map<string, string>();
    for (const record of Array.isArray(records) ? records : []) {
      const {
        bundleId: id,
        catalyst: isCatalyst,
        identifierForVendor,
      } = (record ?? {}) as Record<string, unknown>;
      if (typeof id !== "string" || isCatalyst !== true) continue;
      catalyst.add(id);
      if (typeof identifierForVendor === "string") vendorIds.set(id, identifierForVendor);
    }
    parsed = { file, ino, mtimeMs, size, catalyst, vendorIds };
  }
  return parsed;
}

/**
 * The kind of the build argent last started under `bundleId`, read from its
 * record in {@link trackedMacosAppsFile}. Each start writes the record anew,
 * so the newest start wins when a bundle id is rebuilt as the other kind, and
 * the kind outlives a tool-server restart. "app" when argent never started the
 * bundle id, for a record of an older argent, and when the file cannot be read.
 *
 * `resolveDevice` calls it for every Mac id, so it stays synchronous and cheap:
 * one `stat`, and a parse only after the file changed. A start replaces the
 * file through a rename, so each new version is a new inode.
 */
export function trackedMacosAppKind(bundleId: string): MacosAppKind {
  try {
    return trackedRecords().catalyst.has(bundleId) ? "catalyst" : "app";
  } catch {
    return "app";
  }
}

/**
 * The identifierForVendor that the library of the Mac Catalyst app argent
 * last started under `bundleId` reported, from the same record as
 * {@link trackedMacosAppKind}. Undefined for an AppKit app, a library that
 * predates the report, and an unreadable file.
 */
export function trackedMacosAppVendorId(bundleId: string): string | undefined {
  try {
    return trackedRecords().vendorIds.get(bundleId);
  } catch {
    return undefined;
  }
}
