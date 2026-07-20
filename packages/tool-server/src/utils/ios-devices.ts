import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SIMCTL_KILL_SIGNAL } from "./simctl-config";

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

interface SimctlOutput {
  devices: Record<string, SimctlDevice[]>;
}

/**
 * List all available iOS and tvOS simulators via `xcrun simctl list devices --json`.
 * Returns an empty array when xcrun is missing or the call fails so the
 * rest of the tool surface stays usable on non-mac hosts.
 */
export async function listIosSimulators(): Promise<IosSimulator[]> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "--json"], {
      timeout: 10_000,
      killSignal: SIMCTL_KILL_SIGNAL,
    });
    const data: SimctlOutput = JSON.parse(stdout);
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
