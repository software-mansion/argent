import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Registry } from "@argent/registry";
import {
  NATIVE_DEVTOOLS_NAMESPACE,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../blueprints/native-devtools";

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 10_000;

async function getBootedUdids(): Promise<Set<string>> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "--json"]);
  const data = JSON.parse(stdout) as {
    devices: Record<string, Array<{ udid: string; state: string }>>;
  };
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
  apis: Map<string, NativeDevtoolsApi>
): Promise<void> {
  const ndRef = nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" });
  try {
    apis.set(udid, await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options));
  } catch {
    // Factory tolerates env-init failure; a throw here is structural.
  }
}

export function startSimulatorWatcher(registry: Registry): {
  stop: () => void;
  ready: Promise<void>;
} {
  const apis = new Map<string, NativeDevtoolsApi>();

  async function poll(awaitInit: boolean): Promise<void> {
    let booted: Set<string>;
    try {
      booted = await getBootedUdids();
    } catch {
      // xcrun unavailable or transient error — skip this tick
      return;
    }

    const newUdids = [...booted].filter((u) => !apis.has(u));
    const work: Promise<unknown>[] = newUdids.map((udid) => initUdid(registry, udid, apis));

    for (const [udid, api] of apis) {
      if (!booted.has(udid)) continue;
      const failure = api.getInitFailure();
      if (failure && !failure.givenUp) work.push(api.ensureEnvReady().catch(() => {}));
    }

    if (awaitInit) await Promise.all(work);
    else work.forEach((p) => p.catch(() => {}));

    for (const udid of [...apis.keys()]) {
      if (!booted.has(udid)) {
        apis.delete(udid);
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
