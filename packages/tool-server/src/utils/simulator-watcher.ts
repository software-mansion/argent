import type { Registry } from "@argent/registry";
import {
  NATIVE_DEVTOOLS_NAMESPACE,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../blueprints/native-devtools";
import { readSimctlDevices } from "./ios-devices";

const POLL_INTERVAL_MS = 10_000;

async function getBootedUdids(): Promise<Set<string>> {
  const data = await readSimctlDevices();
  const udids = new Set<string>();
  for (const devices of Object.values(data.devices)) {
    for (const device of devices) {
      if (device.state === "Booted") udids.add(device.udid);
    }
  }
  return udids;
}

async function initUdid(
  registry: Registry,
  udid: string,
  trackedServices: Map<string, NativeDevtoolsApi>
): Promise<void> {
  // A tvOS sim classifies as platform "ios" by UDID shape. native-devtools is
  // iOS *and* tvOS capable — its ensureEnv injects the platform-matched dylib
  // slice (TVOSSIMULATOR bootstrap for Apple TV) — so it is resolved for both.
  const ndRef = nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" });
  try {
    const service = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
    trackedServices.set(udid, service);
  } catch {
    // Factory tolerates env-init failure; a throw here is structural.
  }
}

export function startSimulatorWatcher(registry: Registry): {
  stop: () => void;
  ready: Promise<void>;
} {
  const trackedServices = new Map<string, NativeDevtoolsApi>();

  async function poll(shouldBlockUntilSettled: boolean): Promise<void> {
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

  // First poll is awaited so server startup blocks until ensureEnv has been
  // attempted for all currently-booted simulators — eliminates the launch-app
  // race on the success path.
  const ready = poll(true);

  const interval = setInterval(() => poll(false).catch(() => {}), POLL_INTERVAL_MS);

  return { stop: () => clearInterval(interval), ready };
}
