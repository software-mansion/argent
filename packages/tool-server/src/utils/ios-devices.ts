import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SIMCTL_KILL_SIGNAL } from "./simctl-config";
import {
  configuredAdditionalDeviceSets,
  deviceSetForUdid,
  rememberDeviceSet,
  simctlPrefix,
  type DeviceSetPath,
} from "./ios-device-sets";
import { externalNativeId, isExternalId } from "./external-devices";

const execFileAsync = promisify(execFile);

export interface IosSimulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  runtimeKind?: "mobile" | "tv";
  /** Owning CoreSimulator device-set directory; absent for the default set. */
  deviceSet?: string;
  /**
   * Present, and true, for a foldable simulator: one whose device-type profile
   * lists more than one integrated display (the iPhone Duo's cover and inner
   * panels). Absent on every other device, so their listing is unchanged.
   */
  foldable?: true;
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
    const deviceTypes: string[] = [];
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
        deviceTypes.push(d.deviceTypeIdentifier);
      }
    }
    // A foldable is told from its device-type profile, not from any running
    // service: `list-devices` runs before a simulator-server exists. The
    // per-type verdict is memoized, so the listing pays for it once per type.
    await Promise.all(
      out.map(async (sim, i) => {
        if (sim.runtimeKind !== "mobile") return;
        const foldable = await isFoldableDeviceType(deviceTypes[i]!);
        foldableCache.set(sim.udid, foldable);
        if (foldable) sim.foldable = true;
      })
    );
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
  /**
   * An external provider's simulator is not in any configured set, so the
   * all-sets listing cannot see it. Scope to the set the provider declared and
   * match on the native UDID.
   */
  const listing = isExternalId(udid)
    ? await listDeviceSetSimulators(await deviceSetForUdid(udid))
    : await listIosSimulators();
  const kind = listing.find((s) => s.udid === externalNativeId(udid))?.runtimeKind;
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
  foldableCache.clear();
  deviceTypeFoldableCache.clear();
  deviceTypeBundlePaths = null;
}

// ─── Foldable simulators ───────────────────────────────────────────────

/**
 * Whether a device type is foldable, memoized by identifier: the profile is
 * static for the selected Xcode, and `list-devices` is called often.
 */
const deviceTypeFoldableCache = new Map<string, boolean>();
/** Device-type identifier → `.simdevicetype` bundle path, from `simctl list devicetypes`. */
let deviceTypeBundlePaths: Promise<Map<string, string>> | null = null;
/** Per-UDID verdict, filled by every listing and by {@link isFoldableSimulator}. */
const foldableCache = new Map<string, boolean>();

async function listDeviceTypeBundlePaths(): Promise<Map<string, string>> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devicetypes", "--json"], {
      timeout: 10_000,
      killSignal: SIMCTL_KILL_SIGNAL,
    });
    const data = JSON.parse(stdout) as {
      devicetypes?: Array<{ identifier?: string; bundlePath?: string }>;
    };
    const out = new Map<string, string>();
    for (const t of data.devicetypes ?? []) {
      if (typeof t.identifier === "string" && typeof t.bundlePath === "string") {
        out.set(t.identifier, t.bundlePath);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * The bundle path of a device type. The listing is memoized for the process,
 * and re-read once for an identifier it does not know — a device type added
 * by an Xcode switch since the first listing — before that type is given up on.
 */
async function deviceTypeBundlePath(identifier: string): Promise<string | undefined> {
  deviceTypeBundlePaths ??= listDeviceTypeBundlePaths();
  let paths = await deviceTypeBundlePaths;
  if (paths.has(identifier)) return paths.get(identifier);
  deviceTypeBundlePaths = listDeviceTypeBundlePaths();
  paths = await deviceTypeBundlePaths;
  return paths.get(identifier);
}

/**
 * Count the integrated displays a device-type profile declares. The profile's
 * `capabilities.displays` also lists the tvOut, carPlay and resizable-scene
 * surfaces; only `integrated` ones are panels the guest can render to.
 */
async function countIntegratedDisplays(bundlePath: string): Promise<number> {
  const plist = path.join(bundlePath, "Contents", "Resources", "capabilities.plist");
  if (!fs.existsSync(plist)) return 0;
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      ["-extract", "capabilities.displays", "json", "-o", "-", plist],
      { timeout: 5_000 }
    );
    const displays = JSON.parse(stdout) as Array<{ displayType?: string }>;
    if (!Array.isArray(displays)) return 0;
    return displays.filter((d) => d?.displayType === "integrated").length;
  } catch {
    return 0;
  }
}

/**
 * Whether a device type is foldable: its profile lists more than one
 * integrated display. False for any type whose profile cannot be read, so an
 * unreadable profile degrades to the single-panel behaviour every device had
 * before there were foldables.
 */
export async function isFoldableDeviceType(identifier: string): Promise<boolean> {
  const cached = deviceTypeFoldableCache.get(identifier);
  if (cached !== undefined) return cached;
  const bundlePath = await deviceTypeBundlePath(identifier);
  const foldable = bundlePath ? (await countIntegratedDisplays(bundlePath)) > 1 : false;
  deviceTypeFoldableCache.set(identifier, foldable);
  return foldable;
}

/**
 * Whether the simulator behind `udid` is foldable. Memoized per UDID like the
 * runtime kind, and warmed by every listing, so the hot paths that ask
 * (the simulator-server factory, the visual tools) rarely pay for `simctl`.
 * False for a UDID no listing knows.
 */
export async function isFoldableSimulator(udid: string): Promise<boolean> {
  const cached = foldableCache.get(udid);
  if (cached !== undefined) return cached;
  const listing = isExternalId(udid)
    ? await listDeviceSetSimulators(await deviceSetForUdid(udid))
    : await listIosSimulators();
  const native = externalNativeId(udid);
  const found = listing.find((s) => s.udid === native);
  const foldable = found?.foldable === true;
  // A listing that did not see the UDID at all is not evidence about it;
  // memoize only what a listing answered.
  if (found) foldableCache.set(udid, foldable);
  return foldable;
}
