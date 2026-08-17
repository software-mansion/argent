// CoreSimulator device-set awareness for every simctl consumer.
//
// simctl scopes all operations to ONE device set — the default
// `~/Library/Developer/CoreSimulator/Devices` unless `--set <dir>` is passed.
// The `ios.additionalDeviceSets` configuration (see @argent/configuration-core)
// lists extra sets argent should see, e.g. Radon IDE's
// `~/Library/Caches/com.swmansion.radon-ide/Devices/iOS`. A UDID is only
// addressable inside its owning set, so every simctl invocation needs to know
// which set that is: this module owns that UDID → device-set mapping and the
// one argv builder (`simctlArgsForUdid`) all call sites go through.
//
// The mapping is learned as a side effect of device discovery (list-devices /
// the simulator watcher enumerate every configured set and call
// `rememberDeviceSet`) and lazily on first touch of an unknown UDID (one
// `simctl list` probe per configured set). Default-set membership is cached as
// `null` and produces argv WITHOUT `--set`, keeping the flag off the hot path
// for every setup that doesn't use the feature.

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
 * The additional device-set directories currently configured. Read off disk on
 * every call (the #534 runtime-read design — a config edit applies without a
 * server restart); an unreadable config degrades to "no additional sets".
 */
export function configuredAdditionalDeviceSets(): string[] {
  try {
    return getAdditionalIosDeviceSets();
  } catch {
    return [];
  }
}

/**
 * Record which device set a UDID lives in — called by discovery for every
 * device it sees, so any tool used after a list-devices hits a warm cache.
 * Membership is fixed for a simulator's lifetime, so entries never go stale;
 * a deleted+recreated UDID would be re-learned by the next discovery pass.
 */
export function rememberDeviceSet(udid: string, deviceSet: DeviceSetPath): void {
  deviceSetByUdid.set(udid, deviceSet);
}

async function setContainsUdid(deviceSet: DeviceSetPath, udid: string): Promise<boolean> {
  // Never query a configured set whose directory doesn't exist — simctl would
  // materialize the set dir as a side effect of the probe.
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
 * The device set owning `udid`: a cached verdict when discovery has seen the
 * device, otherwise one probe of the default set and each configured
 * additional set. An unknown UDID resolves to the default set (preserving the
 * exact pre-feature behavior and error messages) and is NOT cached, so a
 * device that appears later — or a set added to the config later — is found
 * on the next call.
 */
export async function deviceSetForUdid(udid: string): Promise<DeviceSetPath> {
  const cached = deviceSetByUdid.get(udid);
  if (cached !== undefined) return cached;
  const additional = configuredAdditionalDeviceSets();
  // No additional sets configured: everything is in the default set; skip the
  // probe entirely rather than paying a simctl list per unknown UDID.
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
 * Cache-only, synchronous view of a UDID's device set: the discovery/probe
 * verdict when one exists, else the default set. For call sites that must stay
 * synchronous (e.g. the ax-daemon spawn, whose `IosHost` contract returns a
 * ChildProcess) and always run after an async step (`bootstrapAx`) has already
 * resolved the mapping.
 */
export function cachedDeviceSetForUdid(udid: string): DeviceSetPath {
  return deviceSetByUdid.get(udid) ?? null;
}

/** The `simctl` argv prefix for a known device set. */
export function simctlPrefix(deviceSet: DeviceSetPath): string[] {
  return deviceSet ? ["simctl", "--set", deviceSet] : ["simctl"];
}

/**
 * Build the full `xcrun` argv (starting with `simctl`) for an operation on
 * `udid`, injecting `--set` when the device lives in an additional set:
 *
 *   execFileAsync("xcrun", await simctlArgsForUdid(udid, ["boot", udid]), …)
 *
 * This is THE choke point every per-device simctl call site routes through.
 * Callers that issue several simctl commands for one device can instead
 * resolve `deviceSetForUdid` once and build argv with `simctlPrefix`.
 */
export async function simctlArgsForUdid(udid: string, args: readonly string[]): Promise<string[]> {
  return [...simctlPrefix(await deviceSetForUdid(udid)), ...args];
}

/**
 * Synchronous sibling of `simctlArgsForUdid` for `execFileSync` call sites
 * (the native profiler's helpers): builds argv from the CACHED device-set
 * verdict. Callers must warm the cache first with an `await
 * deviceSetForUdid(udid)` at their async entry point.
 */
export function simctlArgsForUdidSync(udid: string, args: readonly string[]): string[] {
  return [...simctlPrefix(cachedDeviceSetForUdid(udid)), ...args];
}

/** Test-only: clear the UDID → device-set memo so cases don't leak verdicts. */
export function __resetDeviceSetCacheForTesting(): void {
  deviceSetByUdid.clear();
}
