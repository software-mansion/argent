import { execFile } from "node:child_process";
import { open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  SIMCTL_LIST_DEVICES_LOCK_RETRY_MS,
  SIMCTL_LIST_DEVICES_LOCK_STALE_MS,
  SIMCTL_LIST_DEVICES_LOCK_WAIT_MS,
  SIMCTL_LIST_DEVICES_TIMEOUT_MS,
} from "./simctl-config";

const execFileAsync = promisify(execFile);

export interface IosSimulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  runtimeKind?: "mobile" | "tv";
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  deviceTypeIdentifier: string;
  isAvailable: boolean;
}

export interface SimctlOutput {
  devices: Record<string, SimctlDevice[]>;
}

const DEFAULT_SIMCTL_LIST_DEVICES_LOCK_PATH = join(tmpdir(), "argent-simctl-list-devices.lock");
let simctlListDevicesLockPath: string | null = DEFAULT_SIMCTL_LIST_DEVICES_LOCK_PATH;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

async function removeStaleSimctlListDevicesLock(lockPath: string, now: number): Promise<void> {
  const cleanupLockPath = `${lockPath}.cleanup`;
  let cleanupHandle: FileHandle | undefined;
  try {
    cleanupHandle = await open(cleanupLockPath, "wx");
    await cleanupHandle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now }));
  } catch (err) {
    if (cleanupHandle) {
      await cleanupHandle.close().catch(() => {});
      await unlink(cleanupLockPath).catch(() => {});
    }
    if (isNodeError(err) && err.code === "EEXIST") return;
    throw err;
  }

  try {
    await removeStaleSimctlListDevicesLockWithCleanupLock(lockPath, now);
  } finally {
    await cleanupHandle.close().catch(() => {});
    await unlink(cleanupLockPath).catch((err: unknown) => {
      if (!isNodeError(err) || err.code !== "ENOENT") throw err;
    });
  }
}

async function removeStaleSimctlListDevicesLockWithCleanupLock(
  lockPath: string,
  now: number
): Promise<void> {
  let createdAt: number | undefined;

  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { createdAt?: unknown };
    if (typeof parsed.createdAt === "number") createdAt = parsed.createdAt;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return;
  }

  if (createdAt === undefined) {
    try {
      createdAt = (await stat(lockPath)).mtimeMs;
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") return;
      throw err;
    }
  }

  if (now - createdAt < SIMCTL_LIST_DEVICES_LOCK_STALE_MS) return;

  try {
    await unlink(lockPath);
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") throw err;
  }
}

async function withSimctlListDevicesLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = simctlListDevicesLockPath;
  if (!lockPath) return await fn();

  const started = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch((err: unknown) => {
          if (!isNodeError(err) || err.code !== "ENOENT") throw err;
        });
      }
    } catch (err) {
      if (!isNodeError(err) || err.code !== "EEXIST") throw err;
    }

    const now = Date.now();
    await removeStaleSimctlListDevicesLock(lockPath, now);
    const elapsed = now - started;
    if (elapsed >= SIMCTL_LIST_DEVICES_LOCK_WAIT_MS) {
      throw new Error(
        `timed out waiting for simctl list devices lock after ${SIMCTL_LIST_DEVICES_LOCK_WAIT_MS}ms`
      );
    }
    await sleep(
      Math.min(SIMCTL_LIST_DEVICES_LOCK_RETRY_MS, SIMCTL_LIST_DEVICES_LOCK_WAIT_MS - elapsed)
    );
  }
}

/**
 * Read CoreSimulator's device inventory with a host-wide cap: even if multiple
 * tool-server processes are alive, only one of them should run
 * `xcrun simctl list devices --json` at a time.
 */
export async function readSimctlDevices(): Promise<SimctlOutput> {
  return await withSimctlListDevicesLock(async () => {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "--json"], {
      timeout: SIMCTL_LIST_DEVICES_TIMEOUT_MS,
    });
    return JSON.parse(stdout) as SimctlOutput;
  });
}

/**
 * List all available iOS and tvOS simulators via `xcrun simctl list devices --json`.
 * Returns an empty array when xcrun is missing or the call fails so the
 * rest of the tool surface stays usable on non-mac hosts.
 */
export async function listIosSimulators(): Promise<IosSimulator[]> {
  try {
    const data = await readSimctlDevices();
    const out: IosSimulator[] = [];
    for (const [runtimeId, devices] of Object.entries(data.devices)) {
      // Accept both iOS and tvOS runtimes
      if (!runtimeId.includes("iOS") && !runtimeId.includes("tvOS")) continue;
      for (const d of devices) {
        if (!d.isAvailable) continue;
        const runtimeKind = runtimeId.includes("tvOS") ? "tv" : "mobile";
        out.push({
          udid: d.udid,
          name: d.name,
          state: d.state,
          runtime: runtimeId,
          runtimeKind,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// A simulator's runtime kind is fixed at creation (an iOS sim can't become a
// tvOS one), so memoize per-UDID to keep the hot describe/screenshot path from
// paying the ~100ms `simctl list` cost on every call. Only successful lookups
// are cached; an unknown UDID re-probes (the sim may simply not be booted yet).
const runtimeKindCache = new Map<string, "mobile" | "tv">();

/**
 * Resolve the runtime kind ("mobile" | "tv") of an iOS-shaped simulator UDID,
 * or undefined when it isn't a known available simulator (or xcrun is missing).
 *
 * `resolveDevice` classifies by UDID shape alone and can't tell tvOS from iOS —
 * both are 8-4-4-4-12 UUIDs tagged `platform: "ios"`. Code paths that must
 * branch on tvOS (describe, screenshot) call this to get the real runtime.
 */
export async function getSimulatorRuntimeKind(udid: string): Promise<"mobile" | "tv" | undefined> {
  const cached = runtimeKindCache.get(udid);
  if (cached) return cached;
  const kind = (await listIosSimulators()).find((s) => s.udid === udid)?.runtimeKind;
  if (kind) runtimeKindCache.set(udid, kind);
  return kind;
}

/** True when the given iOS-shaped UDID is actually a tvOS (Apple TV) simulator. */
export async function isTvOsSimulator(udid: string): Promise<boolean> {
  return (await getSimulatorRuntimeKind(udid)) === "tv";
}

/**
 * Memoize a runtime-kind verdict a caller already resolved out-of-band — e.g. the
 * tv-control factory, which fetches the simulator list to validate the target and
 * so holds the kind in hand. Warming the cache here lets the synchronous telemetry
 * reader refine that device without a redundant `simctl` probe, and mirrors how
 * the Android TV factory's `getAndroidRuntimeKind` warms its cache. No-op for an
 * undefined kind; a simulator's kind is fixed at creation, so it never goes stale.
 */
export function cacheSimulatorRuntimeKind(udid: string, kind: "mobile" | "tv" | undefined): void {
  if (kind) runtimeKindCache.set(udid, kind);
}

/**
 * Synchronous, cache-only view of a UDID's runtime kind: returns the memoized
 * "mobile"/"tv" verdict if a prior `getSimulatorRuntimeKind` call resolved it,
 * otherwise undefined. It NEVER runs `simctl` — callers on a latency-sensitive
 * hot path (telemetry platform inference) use this to distinguish tvOS from iOS
 * only when the kind is already known, and fall back to the coarse platform when
 * it isn't, rather than paying a ~100ms probe per call. The cache is warmed as a
 * side effect of the describe/screenshot/keyboard/streaming and tv-remote
 * (tv-control) paths that any real tvOS session exercises.
 */
export function getCachedSimulatorRuntimeKind(udid: string): "mobile" | "tv" | undefined {
  return runtimeKindCache.get(udid);
}

/** Test-only: clear the iOS runtime-kind memo so cases don't leak verdicts. */
export function __resetSimulatorRuntimeKindCacheForTesting(): void {
  runtimeKindCache.clear();
}

/** Test-only: isolate the cross-process simctl lock so parallel test workers do
 * not contend on the real host lock. */
export function __setSimctlListDevicesLockPathForTesting(path: string | null): void {
  simctlListDevicesLockPath = path;
}

export function __resetSimctlListDevicesLockPathForTesting(): void {
  simctlListDevicesLockPath = DEFAULT_SIMCTL_LIST_DEVICES_LOCK_PATH;
}

export async function __removeStaleSimctlListDevicesLockForTesting(
  lockPath: string,
  now: number
): Promise<void> {
  await removeStaleSimctlListDevicesLock(lockPath, now);
}
