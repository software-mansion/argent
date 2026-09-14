import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import { resolveVegaBinary } from "./vega-cli";

/**
 * VVD (Vega Virtual Device) image discovery.
 *
 * The SDK installs bootable VVD images under
 *   <sdkPath>/vega-sdk/<channel>/<version>/vvd/images/<image>
 * e.g. ~/vega/sdk/vega-sdk/main/0.22.6759/vvd/images/tv
 *
 * A *stopped* VVD does not appear in `vega device list` (only running/connected
 * devices do), so bootable VVDs have to be discovered from this images directory
 * rather than the CLI device list. The <version> segment moves with every SDK
 * update, so it is resolved dynamically: trusted from config first (verified on
 * disk), then by scanning the channel dir for the highest installed semver.
 */

interface VegaConfig {
  sdkPath?: string;
  defaultChannel?: string;
  defaultVersion?: string;
}

interface VvdImage {
  /** Image name, e.g. "tv" — boot-device's `vvdImage` argument. */
  name: string;
  /** Absolute VVD package root, passed to `vega virtual-device start -p <path>`. */
  path: string;
}

async function readVegaConfig(): Promise<VegaConfig> {
  try {
    const raw = await readFile(join(homedir(), "vega", "config.json"), "utf-8");
    return JSON.parse(raw) as VegaConfig;
  } catch {
    return {};
  }
}

/** Strip the "<channel>@" prefix the config puts on versions ("main@0.22.6759"). */
function bareVersion(version: string | undefined): string | undefined {
  return version?.includes("@") ? version.split("@").pop() : version;
}

/** `vega-sdk` roots to probe, config-derived first, default last. */
function sdkComponentRoots(config: VegaConfig): string[] {
  const roots = [
    config.sdkPath && join(config.sdkPath, "vega-sdk"),
    join(homedir(), "vega", "sdk", "vega-sdk"),
  ].filter((p): p is string => Boolean(p));
  return Array.from(new Set(roots));
}

/** Resolve the active version dir under `<channelDir>`, preferring config. */
async function resolveVersion(
  channelDir: string,
  preferred: string | undefined
): Promise<string | null> {
  if (preferred && existsSync(join(channelDir, preferred))) return preferred;
  try {
    const versions = (await readdir(channelDir))
      .filter((e) => semver.valid(e))
      .sort(semver.rcompare);
    return versions[0] ?? null;
  } catch {
    return null;
  }
}

/** Directory holding installed VVD images; null when the Vega CLI or an image set is missing. */
export async function resolveVegaSdkImagesDir(): Promise<string | null> {
  if (!(await resolveVegaBinary())) return null;
  const config = await readVegaConfig();
  const channel = config.defaultChannel || "main";
  const preferred = bareVersion(config.defaultVersion);
  for (const root of sdkComponentRoots(config)) {
    const channelDir = join(root, channel);
    const version = await resolveVersion(channelDir, preferred);
    if (!version) continue;
    const imagesDir = join(channelDir, version, "vvd", "images");
    if (existsSync(imagesDir)) return imagesDir;
  }
  return null;
}

export async function listVvdImages(): Promise<VvdImage[]> {
  const dir = await resolveVegaSdkImagesDir();
  if (!dir) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
