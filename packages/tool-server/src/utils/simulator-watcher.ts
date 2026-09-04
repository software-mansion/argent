import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Registry } from "@argent/registry";
import {
  NATIVE_DEVTOOLS_NAMESPACE,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../blueprints/native-devtools";
import {
  configuredAdditionalDeviceSets,
  rememberDeviceSet,
  simctlPrefix,
  type DeviceSetPath,
} from "./ios-device-sets";

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 10_000;

// A tick is skipped once no client has talked to the server for this long. An
// autospawned server whose editor died keeps running until its idle timeout, and
// without this gate it kept spawning `simctl list` every tick — on Xcode 26 each
// spawn makes CoreSimulator re-scan its cryptex runtime volumes, and a few such
// orphans together were enough to saturate a laptop. The MCP health check
// (`GET /tools` every 30 s) keeps a live client well inside the window.
const CLIENT_ACTIVITY_WINDOW_MS = 120_000;

export interface SimulatorWatcherOptions {
  /**
   * Epoch ms of the last inbound request the server saw. Omit to poll
   * unconditionally (tests, or a caller with no request path to observe).
   */
  lastActivityAt?: () => number;
}

/**
 * Every booted simulator runs a `launchd_sim`; none on the host means no
 * simulator is booted. Far cheaper than `simctl list` — no CoreSimulator XPC, no
 * runtime-volume scan. Exit 1 is pgrep's "no match"; any other failure (pgrep
 * missing, signal) is not evidence of anything, so fall back to asking simctl.
 */
async function anySimulatorProcessRunning(): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-x", "launchd_sim"]);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code !== 1;
  }
}

async function getBootedUdidsInSet(deviceSet: DeviceSetPath): Promise<Set<string>> {
  const { stdout } = await execFileAsync("xcrun", [
    ...simctlPrefix(deviceSet),
    "list",
    "devices",
    "--json",
  ]);
  const data = JSON.parse(stdout) as {
    devices: Record<string, Array<{ udid: string; state: string }>>;
  };
  const udids = new Set<string>();
  for (const devices of Object.values(data.devices)) {
    for (const device of devices) {
      if (device.state === "Booted") {
        udids.add(device.udid);
        // Warm the UDID → device-set map so ios-host's simctl spawns — including
        // the cache-only ax-daemon one — target the right set.
        rememberDeviceSet(device.udid, deviceSet);
      }
    }
  }
  return udids;
}

/**
 * Booted simulators across the default set and every configured additional set.
 * Throws if any set fails, so the caller skips the tick instead of reading a
 * transient error as "everything shut down". A configured set whose directory is
 * missing is not queried — querying would make simctl materialize it.
 */
async function getBootedUdids(): Promise<Set<string>> {
  const sets: DeviceSetPath[] = [
    null,
    ...configuredAdditionalDeviceSets().filter((p) => fs.existsSync(p)),
  ];
  const perSet = await Promise.all(sets.map(getBootedUdidsInSet));
  return new Set(perSet.flatMap((s) => [...s]));
}

async function initUdid(
  registry: Registry,
  udid: string,
  trackedServices: Map<string, NativeDevtoolsApi>
): Promise<void> {
  // tvOS sims are also platform "ios" (classified by UDID shape) and
  // native-devtools covers them: its ensureEnv picks the TVOSSIMULATOR dylib
  // slice.
  const ndRef = nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" });
  try {
    const service = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
    trackedServices.set(udid, service);
  } catch {
    // Factory tolerates env-init failure; a throw here is structural.
  }
}

export function startSimulatorWatcher(
  registry: Registry,
  options: SimulatorWatcherOptions = {}
): {
  stop: () => void;
  ready: Promise<void>;
} {
  const trackedServices = new Map<string, NativeDevtoolsApi>();

  async function poll(shouldBlockUntilSettled: boolean): Promise<void> {
    // Nothing tracked and no simulator process on the host: there is nothing to
    // attach to and nothing to dispose, so skip the simctl round-trip. While a
    // tracked simulator exists we still ask simctl, so its shutdown is seen and
    // the service disposed.
    if (trackedServices.size === 0 && !(await anySimulatorProcessRunning())) return;

    let booted: Set<string>;
    try {
      booted = await getBootedUdids();
    } catch {
      // xcrun unavailable or transient error — skip this tick
      return;
    }

    const newUdids = [...booted].filter((udid) => !trackedServices.has(udid));
    const pendingAttempts: Promise<unknown>[] = newUdids.map((udid) =>
      initUdid(registry, udid, trackedServices)
    );

    for (const [udid, service] of trackedServices) {
      if (!booted.has(udid)) continue;
      const failure = service.getInitFailure();
      if (failure && !failure.givenUp) {
        pendingAttempts.push(service.ensureEnvReady().catch(() => {}));
      }
    }

    if (shouldBlockUntilSettled) await Promise.all(pendingAttempts);
    else pendingAttempts.forEach((p) => p.catch(() => {}));

    for (const udid of [...trackedServices.keys()]) {
      if (!booted.has(udid)) {
        trackedServices.delete(udid);
        registry.disposeService(`${NATIVE_DEVTOOLS_NAMESPACE}:${udid}`).catch(() => {});
      }
    }
  }

  // Awaited: the server does not bind until ensureEnv has been attempted for
  // every booted simulator, so launch-app cannot race it.
  const ready = poll(true);

  const interval = setInterval(() => {
    // Stale client activity: nobody can act on what this tick would learn. The
    // first request after the gap refreshes the timestamp and the next tick
    // polls again.
    const last = options.lastActivityAt?.();
    if (last !== undefined && Date.now() - last > CLIENT_ACTIVITY_WINDOW_MS) return;
    poll(false).catch(() => {});
  }, POLL_INTERVAL_MS);

  return { stop: () => clearInterval(interval), ready };
}
