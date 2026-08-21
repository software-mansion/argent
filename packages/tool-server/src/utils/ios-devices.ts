import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPhysicalIosUdid } from "./device-info";
import { SIMCTL_KILL_SIGNAL } from "./simctl-config";
import {
  configuredAdditionalDeviceSets,
  rememberDeviceSet,
  simctlPrefix,
  type DeviceSetPath,
} from "./ios-device-sets";

const execFileAsync = promisify(execFile);

interface IosSimulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  runtimeKind?: "mobile" | "tv";
  /** Owning CoreSimulator device-set directory; absent for the default set. */
  deviceSet?: string;
}

interface IosPhysicalDevice {
  udid: string;
  name: string;
  /** Apple product type, e.g. "iPhone15,4". Null when devicectl omits it. */
  productType: string | null;
  /** Always "connected" — only currently-reachable devices are returned. */
  state: string;
}

interface DevicectlDevice {
  hardwareProperties?: { udid?: string; platform?: string; productType?: string };
  deviceProperties?: { name?: string };
  connectionProperties?: { transportType?: string; tunnelState?: string };
}

interface DevicectlOutput {
  result?: { devices?: DevicectlDevice[] };
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
  // Never query a configured set whose directory doesn't exist — simctl would
  // materialize the set dir as a side effect, turning a config typo into a
  // stray directory on disk.
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
 * List all available iOS and tvOS simulators via `xcrun simctl list devices
 * --json` — the default device set plus every configured additional set
 * (`ios.additionalDeviceSets`, e.g. Radon IDE's). Each device is tagged with
 * its owning set and remembered in the UDID → device-set map, so any later
 * per-device simctl call targets the right set. Returns an empty array when
 * xcrun is missing or every set fails, so the rest of the tool surface stays
 * usable on non-mac hosts.
 */
export async function listIosSimulators(): Promise<IosSimulator[]> {
  const sets: DeviceSetPath[] = [null, ...configuredAdditionalDeviceSets()];
  const perSet = await Promise.all(sets.map(listDeviceSetSimulators));
  const out: IosSimulator[] = [];
  const seen = new Set<string>();
  for (const simulators of perSet) {
    for (const sim of simulators) {
      // A UDID can only live in one set; keep the first sighting (default set
      // first) as a guard against a set listed twice in the config.
      if (seen.has(sim.udid)) continue;
      seen.add(sim.udid);
      rememberDeviceSet(sim.udid, sim.deviceSet ?? null);
      out.push(sim);
    }
  }
  return out;
}

/**
 * Filter a `devicectl list devices` payload down to the physical iOS devices
 * that are reachable right now. See the per-branch reasoning inline.
 */
export function parsePhysicalIosDevices(data: DevicectlOutput): IosPhysicalDevice[] {
  const out: IosPhysicalDevice[] = [];
  for (const d of data.result?.devices ?? []) {
    const udid = d.hardwareProperties?.udid;
    const platform = d.hardwareProperties?.platform;
    const transport = d.connectionProperties?.transportType;
    // Keep only iOS (skip watchOS/tvOS), with a physical ECID UDID, that is
    // currently reachable. The `isPhysicalIosUdid` (8hex-16hex) check is
    // load-bearing: `devicectl list devices` also enumerates the host's iOS
    // *simulators*, which report `platform: "iOS"` with
    // `transportType: "sameMachine"` (verified against real devicectl JSON) —
    // without the shape gate every simulator surfaces as a phantom physical
    // device. It also keeps discovery consistent with `classifyDevice`, which
    // routes only this UDID shape to the CoreDevice backend. A reachable device
    // reports a `transportType` (wired/network); paired-but-offline ones carry
    // `tunnelState: "unavailable"` and no transport, and are dropped.
    if (!udid || platform !== "iOS" || !isPhysicalIosUdid(udid) || !transport) continue;
    if (d.connectionProperties?.tunnelState === "unavailable") continue;
    out.push({
      udid,
      name: d.deviceProperties?.name ?? "iPhone",
      productType: d.hardwareProperties?.productType ?? null,
      state: "connected",
    });
  }
  return out;
}

/**
 * List connected physical iOS devices via `xcrun devicectl list devices`.
 *
 * `--json-output -` writes the machine-readable payload to stdout (devicectl's
 * own documented spelling for it), so this parses stdout like every other
 * discovery backend here rather than routing through a temp file. `--quiet`
 * keeps the human-readable table off stdout so the JSON is the whole stream.
 *
 * `killSignal` mirrors `listIosSimulators` above: `execFile`'s `timeout` only
 * sends SIGTERM, which a wedged Xcode CLI can trap and ignore — the promise
 * would then never settle and the child would outlive the call. `list-devices`
 * runs often, so that would leak one stuck process per invocation.
 *
 * Returns an empty array on any failure so the rest of `list-devices` stays
 * usable on non-mac hosts or without Xcode.
 */
export async function listIosDevices(): Promise<IosPhysicalDevice[]> {
  if (process.platform !== "darwin") return [];
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      ["devicectl", "list", "devices", "--quiet", "--json-output", "-"],
      { timeout: 15_000, killSignal: SIMCTL_KILL_SIGNAL }
    );
    const data: DevicectlOutput = JSON.parse(stdout);
    return parsePhysicalIosDevices(data);
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
 *
 * A physical-iPhone UDID short-circuits: hardware is never a simulator runtime,
 * so `simctl` could only ever answer "not found". The memo caches successful
 * lookups only, so without this guard every describe / screenshot / await-* call
 * against a physical device would re-spawn `simctl list devices` (~0.3s and a
 * process each) forever, and the closest thing to a positive answer would still
 * be undefined.
 */
export async function getSimulatorRuntimeKind(udid: string): Promise<"mobile" | "tv" | undefined> {
  if (isPhysicalIosUdid(udid)) return undefined;
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
