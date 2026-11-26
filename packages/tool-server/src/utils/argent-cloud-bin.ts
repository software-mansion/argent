import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import { commandOnPath } from "./command-on-path";

const execFileAsync = promisify(execFile);

export const MIN_ARGENT_CLOUD_VERSION = "1.1.0";

const LEGACY_NAME = "sim-remote";
const VERSION_TIMEOUT_MS = 5_000;

let cachedBin: string | undefined;
const versionCache = new Map<string, string | null>();

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function onPathOrLocalBin(name: string): Promise<string | null> {
  if (await commandOnPath(name)) return name;
  const local = join(homedir(), ".local", "bin", name);
  return (await isExecutable(local)) ? local : null;
}

/**
 * The Argent Cloud CLI to run: `ARGENT_CLOUD_BIN`, then `argent-cloud`, then the
 * legacy `sim-remote`, each on PATH or in `~/.local/bin` (MCP clients often start
 * with a minimal PATH). A bare name is returned when PATH has it, so it prints
 * the way the user types it. Null when none is installed; that is not cached.
 */
export async function findArgentCloudBin(): Promise<string | null> {
  if (cachedBin) return cachedBin;
  const fromEnv = process.env.ARGENT_CLOUD_BIN?.trim();
  const found =
    fromEnv || (await onPathOrLocalBin("argent-cloud")) || (await onPathOrLocalBin(LEGACY_NAME));
  if (found) cachedBin = found;
  return found;
}

/** The binary to spawn. With none installed, the legacy name, so the spawn fails with ENOENT. */
export async function argentCloudBin(): Promise<string> {
  return (await findArgentCloudBin()) ?? LEGACY_NAME;
}

/** The command to quote to the agent: the last binary resolved, else the legacy name. */
export function argentCloudCommand(): string {
  return cachedBin ?? LEGACY_NAME;
}

export function forgetArgentCloudBin(): void {
  cachedBin = undefined;
}

export function parseArgentCloudVersion(output: string): string | null {
  const match = /^\S+ v?(\d+\.\d+\.\d+\S*)$/.exec(output.trim().split("\n")[0]?.trim() ?? "");
  return match && semver.valid(match[1]) ? match[1] : null;
}

/** Whether a reported version is below the minimum. Prereleases of the minimum count as recent. */
export function isArgentCloudOutdated(version: string): boolean {
  const coerced = semver.coerce(version);
  return coerced !== null && semver.lt(coerced, MIN_ARGENT_CLOUD_VERSION);
}

async function readVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      encoding: "utf8",
    });
    return parseArgentCloudVersion(stdout);
  } catch {
    return null;
  }
}

/**
 * The installed CLI's version, or null when none is installed or it has no
 * `--version` (1.0.x). Read once per binary.
 */
export async function argentCloudVersion(): Promise<string | null> {
  const bin = await findArgentCloudBin();
  if (!bin) return null;
  if (!versionCache.has(bin)) versionCache.set(bin, await readVersion(bin));
  return versionCache.get(bin) ?? null;
}

/** Test-only: forget the resolved binary and the versions read. */
export function __resetArgentCloudBinForTests(): void {
  cachedBin = undefined;
  versionCache.clear();
}
