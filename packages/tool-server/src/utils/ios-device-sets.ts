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
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { getAdditionalIosDeviceSets } from "@argent/configuration-core";
import { SIMCTL_KILL_SIGNAL } from "./simctl-config";
import {
  assertExternalCapabilitySync,
  externalNativeId,
  findExternalDevice,
  isExternalId,
  type ExternalCapability,
} from "./external-devices";

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
  const external = externalDeviceSet(udid);
  if (external !== undefined) return external;
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
  return externalDeviceSet(udid) ?? deviceSetByUdid.get(udid) ?? null;
}

/**
 * The device set an external provider declared for `udid`, or `undefined` when
 * `udid` is not an external device at all.
 *
 * Never probed and never memoized: the provider states the set in its
 * descriptor, which is re-read on every call, so a device that moves or is
 * withdrawn is reflected immediately. A provider that declares no `deviceSet`
 * means the default set, exactly as for a local simulator.
 */
function externalDeviceSet(udid: string): DeviceSetPath | undefined {
  if (!isExternalId(udid)) return undefined;
  return findExternalDevice(udid)?.deviceSet ?? null;
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
export async function simctlArgsForUdid(
  udid: string,
  args: readonly string[],
  options?: SimctlEntitlement
): Promise<string[]> {
  /**
   * Running simctl against somebody else's simulator needs an explicit
   * grant. Checking at this choke point rather than at each call site means
   * a provider that withholds `simctl` denies all of them at once,
   * including tools added later.
   */
  assertSimctlEntitlement(udid, options);
  return [...simctlPrefix(await deviceSetForUdid(udid)), ...nativeArgs(udid, args)];
}

/**
 * Which grant entitles a caller to build `simctl` argv for an external device.
 * Defaults to `simctl`. Blueprints whose granted mechanism is itself
 * implemented with `simctl` spawns (`ax-service`, `native-devtools`,
 * `native-profiler`) name that mechanism instead, so it doesn't additionally
 * require the general-purpose `simctl` grant.
 */
type SimctlEntitlement = { granted?: ExternalCapability };

function assertSimctlEntitlement(udid: string, options?: SimctlEntitlement): void {
  if (!isExternalId(udid)) return;
  const capability = options?.granted ?? "simctl";
  assertExternalCapabilitySync(capability, udid, capability);
}

/**
 * Prefix and target id for a device about to receive several simctl commands.
 *
 * `simctlArgsForUdid` is the choke point for a single call; a caller issuing a
 * run of them resolves once through here instead. The two travel together on
 * purpose: an external device needs BOTH the provider's `--set` and its real
 * UDID, and taking only the prefix (the shape this replaced) silently passes
 * the `ext:` id straight to simctl.
 *
 * Gated like {@linkcode simctlArgsForUdid} — the pair form is not a way
 * around the choke point.
 */
export async function simctlTargetForUdid(
  udid: string,
  options?: SimctlEntitlement
): Promise<{ nativeId: string; prefix: string[] }> {
  assertSimctlEntitlement(udid, options);
  return { nativeId: externalNativeId(udid), prefix: simctlPrefix(await deviceSetForUdid(udid)) };
}

/**
 * Synchronous sibling of {@linkcode simctlTargetForUdid}, from the cached verdict.
 */
export function simctlTargetForUdidSync(
  udid: string,
  options?: SimctlEntitlement
): { nativeId: string; prefix: string[] } {
  assertSimctlEntitlement(udid, options);
  return { nativeId: externalNativeId(udid), prefix: simctlPrefix(cachedDeviceSetForUdid(udid)) };
}

/**
 * Synchronous sibling of `simctlArgsForUdid` for `execFileSync` call sites (the
 * native profiler's helpers): argv from the CACHED verdict, so callers must warm
 * the cache with an `await deviceSetForUdid(udid)` at their async entry point.
 */
export function simctlArgsForUdidSync(
  udid: string,
  args: readonly string[],
  options?: SimctlEntitlement
): string[] {
  /**
   * A withdrawn external device must not fall back to the default set: simctl
   * would report a baffling "device not found" instead of naming the real
   * problem. The async form gets this from its entitlement assertion.
   */
  if (isExternalId(udid) && !findExternalDevice(udid)) {
    throw new FailureError(
      `External device '${udid}' is not currently offered by its provider, ` +
        `so its CoreSimulator device set is unknown.`,
      {
        error_code: FAILURE_CODES.EXTERNAL_DEVICE_UNAVAILABLE,
        error_kind: "validation",
        failure_area: "tool_server",
        failure_stage: "external_device_simctl_argv_sync",
      }
    );
  }
  assertSimctlEntitlement(udid, options);
  return [...simctlPrefix(cachedDeviceSetForUdid(udid)), ...nativeArgs(udid, args)];
}

/**
 * Replace an external device id wherever the caller spelled it with the real
 * UDID simctl knows. Verbs place it differently (`launch <udid> <bundle>`,
 * `privacy <udid> grant …`), some twice. Identity for a local udid.
 */
function nativeArgs(udid: string, args: readonly string[]): string[] {
  if (!isExternalId(udid)) return [...args];
  const nativeId = externalNativeId(udid);
  return args.map((argument) => (argument === udid ? nativeId : argument));
}

/** Test-only: clear the UDID → device-set memo so cases don't leak verdicts. */
export function __resetDeviceSetCacheForTesting(): void {
  deviceSetByUdid.clear();
}
