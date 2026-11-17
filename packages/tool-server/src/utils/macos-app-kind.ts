import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The two kinds of native Mac app. A Mac Catalyst app (`catalyst`) is an iPad
 * (UIKit) app built for the Mac. It has the same `macos-app-<bundle id>` id and
 * the same platform as an AppKit app (`app`), but its UIKit views are not in
 * its AppKit view tree, so the tools that read that tree refuse it.
 */
export type MacosAppKind = "app" | "catalyst";

/** `~/.argent/macos-apps.json`: the record of each app argent started (macos-apps.ts). */
export function trackedMacosAppsFile(): string {
  return path.join(os.homedir(), ".argent", "macos-apps.json");
}

/** The file as last parsed, and the bundle ids it records as Mac Catalyst apps. */
let parsed: {
  file: string;
  ino: number;
  mtimeMs: number;
  size: number;
  catalyst: ReadonlySet<string>;
} | null = null;

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
      for (const record of Array.isArray(records) ? records : []) {
        const { bundleId: id, catalyst: isCatalyst } = (record ?? {}) as Record<string, unknown>;
        if (typeof id === "string" && isCatalyst === true) catalyst.add(id);
      }
      parsed = { file, ino, mtimeMs, size, catalyst };
    }
    return parsed.catalyst.has(bundleId) ? "catalyst" : "app";
  } catch {
    return "app";
  }
}
