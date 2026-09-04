import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { HermesCpuProfile, DevToolsFiberCommit } from "../types/input";

const DEBUG_DIR_NAME = "argent-profiler-cwd";

export async function getDebugDir(): Promise<string> {
  const dir = join(tmpdir(), DEBUG_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
};

/** Pretty-printed JSON dump. Non-fatal — returns null on error. */
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

/** Unindented JSON dump, for large profiling data. Non-fatal — returns null on error. */
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
 * Validates the shape so an old or partial dump fails here with an actionable
 * error rather than deep inside `buildCpuSampleIndex`.
 */
export async function readCpuProfile(path: string): Promise<HermesCpuProfile> {
  const json = await fs.readFile(path, "utf8");
  const parsed = JSON.parse(json) as Partial<HermesCpuProfile> | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `On-disk CPU profile at ${path} is missing or not an object. The session dump is corrupt or was written by an incompatible tool-server version; rerun react-profiler-start/stop to capture a fresh session.`
    );
  }
  if (
    !Array.isArray(parsed.samples) ||
    !Array.isArray(parsed.nodes) ||
    !Array.isArray(parsed.timeDeltas)
  ) {
    throw new Error(
      `On-disk CPU profile at ${path} is malformed (missing samples/nodes/timeDeltas). ` +
        `The session was likely recorded against a release build where Hermes CPU sampling never started, or the dump was truncated. ` +
        `Rerun react-profiler-start on a dev build and retry.`
    );
  }
  if (typeof parsed.startTime !== "number" || typeof parsed.endTime !== "number") {
    throw new Error(
      `On-disk CPU profile at ${path} is missing startTime/endTime timestamps; the recording is incomplete and cannot be analysed.`
    );
  }
  return parsed as HermesCpuProfile;
}

interface CommitTreeOnDisk {
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
    // [commitIndex, droppedFiberCount, droppedActualDurationMs] for fibers whose
    // display name could not be resolved at stop time (transient/unmounted).
    unattributedByCommit?: Array<[number, number, number]> | null;
  };
}

export async function readCommitTree(path: string): Promise<CommitTreeOnDisk> {
  const json = await fs.readFile(path, "utf8");
  return JSON.parse(json) as CommitTreeOnDisk;
}
