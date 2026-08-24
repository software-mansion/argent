import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SIMCTL_KILL_SIGNAL } from "./simctl-config";
import {
  configuredAdditionalDeviceSets,
  rememberDeviceSet,
  simctlPrefix,
  type DeviceSetPath,
} from "./ios-device-sets";

const execFileAsync = promisify(execFile);

export interface IosSimulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  runtimeKind?: "mobile" | "tv";
  /** Owning CoreSimulator device-set directory; absent for the default set. */
  deviceSet?: string;
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

/** List one device set's iOS/tvOS simulators; [] on any failure. */
async function listDeviceSetSimulators(deviceSet: DeviceSetPath): Promise<IosSimulator[]> {
  // simctl materializes a missing `--set` directory as a side effect, so a
  // config typo would leave a stray directory on disk.
  if (deviceSet && !fs.existsSync(deviceSet)) return [];
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      [...simctlPrefix(deviceSet), "list", "devices", "--json"],
      { timeout: 10_000, killSignal: SIMCTL_KILL_SIGNAL }
    );
    const data: SimctlOutput = JSON.parse(stdout);
    const out: IosSimulator[] = [];
    for (const [runtimeId, devices] of Object.entries(data.devices)) {
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
          ...(deviceSet ? { deviceSet } : {}),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * List available iOS and tvOS simulators across the default device set and every
 * configured additional set (`ios.additionalDeviceSets`). Each device is tagged
 * with its owning set and remembered in the UDID → device-set map, so later
 * per-device simctl calls target the right set. Empty when xcrun is missing or
 * every set fails, keeping the rest of the tool surface usable off macOS.
 */
export async function listIosSimulators(): Promise<IosSimulator[]> {
  const sets: DeviceSetPath[] = [null, ...configuredAdditionalDeviceSets()];
  const perSet = await Promise.all(sets.map(listDeviceSetSimulators));
  const out: IosSimulator[] = [];
  const seen = new Set<string>();
  for (const simulators of perSet) {
    for (const sim of simulators) {
      // A UDID lives in exactly one set; first sighting wins, guarding against
      // a set listed twice in the config.
      if (seen.has(sim.udid)) continue;
      seen.add(sim.udid);
      rememberDeviceSet(sim.udid, sim.deviceSet ?? null);
      out.push(sim);
    }
  }
  return out;
}

// A simulator's runtime kind is fixed at creation, so memoize per-UDID and keep
// the hot describe/screenshot path off `simctl list`.
const runtimeKindCache = new Map<string, "mobile" | "tv">();

/**
 * Runtime kind of an iOS-shaped simulator UDID, or undefined when it isn't a
 * known available simulator (or xcrun is missing).
 *
 * `resolveDevice` classifies by UDID shape alone — tvOS and iOS sims are both
 * 8-4-4-4-12 UUIDs tagged `platform: "ios"` — so paths that must branch on tvOS
 * (describe, screenshot) call this for the real runtime.
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
 * Memoize a runtime-kind verdict a caller already resolved out-of-band — the
 * tv-control factory holds one from the simulator list it fetches to validate the
 * target — so the synchronous telemetry reader can refine that device without a
 * redundant `simctl` probe. Mirrors how `getAndroidRuntimeKind` warms the Android
 * TV factory's cache.
 */
export function cacheSimulatorRuntimeKind(udid: string, kind: "mobile" | "tv" | undefined): void {
  if (kind) runtimeKindCache.set(udid, kind);
}

/**
 * Cache-only view of a UDID's runtime kind: it NEVER runs `simctl`, so the
 * telemetry hot path can distinguish tvOS from iOS when the kind is already known
 * and fall back to the coarse platform otherwise. Warmed by the
 * describe/screenshot/keyboard/screen-recording and tv-control paths any real
 * tvOS session exercises.
 */
export function getCachedSimulatorRuntimeKind(udid: string): "mobile" | "tv" | undefined {
  return runtimeKindCache.get(udid);
}

/** Test-only: clear the iOS runtime-kind memo so cases don't leak verdicts. */
export function __resetSimulatorRuntimeKindCacheForTesting(): void {
  runtimeKindCache.clear();
}
