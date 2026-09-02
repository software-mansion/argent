// simctl scopes every operation to ONE device set — the default
// `~/Library/Developer/CoreSimulator/Devices` unless `--set <dir>` is passed —
// so a UDID is only addressable inside its owning set. `ios.additionalDeviceSets`
// (@argent/configuration-core) lists the extra sets to look in, e.g. Radon IDE's
// `~/Library/Caches/com.swmansion.radon-ide/Devices/iOS`; this module owns the
// UDID → device-set mapping the simctl call sites resolve through.
//
// The mapping is learned by discovery (list-devices and the simulator watcher
// call `rememberDeviceSet` for every device they see) and lazily by probing each
// configured set on first touch of an unknown UDID. Default-set membership is
// `null` and yields argv without `--set`, so setups without additional sets
// never pay for the feature.

import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAdditionalIosDeviceSets } from "@argent/configuration-core";
import { SIMCTL_KILL_SIGNAL } from "./simctl-config";

const execFileAsync = promisify(execFile);

/** `null` = the default CoreSimulator set (no `--set` flag). */
export type DeviceSetPath = string | null;

const deviceSetByUdid = new Map<string, DeviceSetPath>();

/**
 * The configured additional device-set directories, re-read off disk on every
 * call so a config edit applies without a server restart. An invalid config
 * reads as none.
 */
export function configuredAdditionalDeviceSets(): string[] {
  try {
    return getAdditionalIosDeviceSets();
  } catch {
    return [];
  }
}

/**
 * Record which device set a UDID lives in — discovery calls this for every
 * device it sees, so tools used after a list-devices hit a warm cache.
 * Membership is fixed for a simulator's lifetime, so entries never go stale.
 */
export function rememberDeviceSet(udid: string, deviceSet: DeviceSetPath): void {
  deviceSetByUdid.set(udid, deviceSet);
}

async function setContainsUdid(deviceSet: DeviceSetPath, udid: string): Promise<boolean> {
  // Probing a configured set whose directory is missing would make simctl
  // materialize it.
  if (deviceSet && !fs.existsSync(deviceSet)) return false;
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      [...simctlPrefix(deviceSet), "list", "devices", "--json"],
      { timeout: 10_000, killSignal: SIMCTL_KILL_SIGNAL }
    );
    const data = JSON.parse(stdout) as {
      devices?: Record<string, Array<{ udid?: string }>>;
    };
    return Object.values(data.devices ?? {}).some((devices) =>
      devices.some((d) => d.udid === udid)
    );
  } catch {
    return false;
  }
}

/**
 * The device set owning `udid`: the cached verdict, else one probe of the
 * default set and of each configured additional set. A UDID found in none
 * resolves to the default set (preserving the pre-feature behavior and error
 * messages) and is NOT cached, so a device — or a config entry — that appears
 * later is found on the next call.
 */
export async function deviceSetForUdid(udid: string): Promise<DeviceSetPath> {
  const cached = deviceSetByUdid.get(udid);
  if (cached !== undefined) return cached;
  const additional = configuredAdditionalDeviceSets();
  // Nothing to probe when only the default set exists; skip the simctl list.
  if (additional.length === 0) return null;
  for (const deviceSet of [null, ...additional]) {
    if (await setContainsUdid(deviceSet, udid)) {
      deviceSetByUdid.set(udid, deviceSet);
      return deviceSet;
    }
  }
  return null;
}

/**
 * Cache-only, synchronous view of a UDID's device set, falling back to the
 * default set. For call sites that cannot await (e.g. the ax-daemon spawn,
 * whose `IosHost` contract returns a ChildProcess) and always run after an
 * async step (`bootstrapAx`) has resolved the mapping.
 */
export function cachedDeviceSetForUdid(udid: string): DeviceSetPath {
  return deviceSetByUdid.get(udid) ?? null;
}

/** The `simctl` argv prefix for a known device set. */
export function simctlPrefix(deviceSet: DeviceSetPath): string[] {
  return deviceSet ? ["simctl", "--set", deviceSet] : ["simctl"];
}

/**
 * Full `xcrun` argv (starting with `simctl`) for an operation on `udid`,
 * injecting `--set` when the device lives in an additional set. Callers that
 * issue several simctl commands for one device can instead resolve
 * `deviceSetForUdid` once and build argv with `simctlPrefix`.
 */
export async function simctlArgsForUdid(udid: string, args: readonly string[]): Promise<string[]> {
  return [...simctlPrefix(await deviceSetForUdid(udid)), ...args];
}

/**
 * Synchronous sibling of `simctlArgsForUdid` for `execFileSync` call sites (the
 * native profiler's helpers): argv from the CACHED verdict, so callers must warm
 * the cache with an `await deviceSetForUdid(udid)` at their async entry point.
 */
export function simctlArgsForUdidSync(udid: string, args: readonly string[]): string[] {
  return [...simctlPrefix(cachedDeviceSetForUdid(udid)), ...args];
}

/** Test-only: clear the UDID → device-set memo so cases don't leak verdicts. */
export function __resetDeviceSetCacheForTesting(): void {
  deviceSetByUdid.clear();
}
