import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { HermesCpuProfile, DevToolsFiberCommit } from "../types/input";

const DEBUG_DIR_NAME = "argent-profiler-cwd";

/**
 * Returns (and creates if needed) /tmp/argent-profiler-cwd/.
 */
export async function getDebugDir(): Promise<string> {
  const dir = join(tmpdir(), DEBUG_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
};

/**
 * Writes `data` as pretty-printed JSON to `<dir>/<filename>`.
 * Returns the full file path. Non-fatal — returns null on error.
 */
export async function writeDump(
  dir: string,
  filename: string,
  data: unknown
): Promise<string | null> {
  try {
    const path = join(dir, filename);
    const json = JSON.stringify(data, jsonReplacer, 2);
    await fs.writeFile(path, json, "utf8");
    return path;
  } catch {
    return null;
  }
}

/**
 * Writes `data` as compact (no indentation) JSON to `<dir>/<filename>`.
 * Saves ~30% string size vs pretty-printed for large profiling data.
 * Returns the full file path. Non-fatal — returns null on error.
 */
export async function writeDumpCompact(
  dir: string,
  filename: string,
  data: unknown
): Promise<string | null> {
  try {
    const path = join(dir, filename);
    const json = JSON.stringify(data, jsonReplacer);
    await fs.writeFile(path, json, "utf8");
    return path;
  } catch {
    return null;
  }
}

/**
 * Read a CPU profile from disk.
 */
export async function readCpuProfile(path: string): Promise<HermesCpuProfile> {
  const json = await fs.readFile(path, "utf8");
  return JSON.parse(json) as HermesCpuProfile;
}

export interface CommitTreeOnDisk {
  commits: DevToolsFiberCommit[];
  meta?: {
    detectedArchitecture?: "bridge" | "bridgeless" | null;
    anyCompilerOptimized?: boolean | null;
    hotCommitIndices?: number[] | null;
    totalReactCommits?: number | null;
    profileStartWallMs?: number | null;
    projectRoot?: string | null;
    deviceId?: string | null;
    port?: number | null;
    appName?: string | null;
    deviceName?: string | null;
  };
}

/**
 * Read a commit tree (with meta) from disk.
 */
export async function readCommitTree(path: string): Promise<CommitTreeOnDisk> {
  const json = await fs.readFile(path, "utf8");
  return JSON.parse(json) as CommitTreeOnDisk;
}
