import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Registry } from "@argent/registry";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../blueprints/native-devtools";

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

async function initSimulator(
  registry: Registry,
  watchedUdids: Set<string>,
  udid: string
): Promise<void> {
  watchedUdids.add(udid);
  try {
    await registry.resolveService(`${NATIVE_DEVTOOLS_NAMESPACE}:${udid}`);
  } catch {
    // Service failed to start (e.g. simulator shut down mid-init); retry next tick
    watchedUdids.delete(udid);
  }
}

export function startSimulatorWatcher(registry: Registry): {
  stop: () => void;
  ready: Promise<void>;
} {
  const watchedUdids = new Set<string>();

  async function poll(awaitInit: boolean): Promise<void> {
    let booted: Set<string>;
    try {
      booted = await getBootedUdids();
    } catch {
      // xcrun unavailable or transient error — skip this tick
      return;
    }

    // New simulators: start NativeDevtools service (sets launchd env + opens socket)
    const newUdids = [...booted].filter((udid) => !watchedUdids.has(udid));
    if (awaitInit) {
      // First poll: await all ensureEnv completions so the server is only marked
      // ready after injection is guaranteed for all currently-booted simulators.
      await Promise.all(newUdids.map((udid) => initSimulator(registry, watchedUdids, udid)));
    } else {
      // Subsequent polls: fire-and-forget to avoid blocking the interval tick.
      newUdids.forEach((udid) => {
        initSimulator(registry, watchedUdids, udid).catch(() => {});
      });
    }

    // Simulators that shut down: dispose service and clean up
    for (const udid of watchedUdids) {
      if (!booted.has(udid)) {
        watchedUdids.delete(udid);
        registry.disposeService(`${NATIVE_DEVTOOLS_NAMESPACE}:${udid}`).catch(() => {});
      }
    }
  }

  // First poll is awaited — server startup blocks until ensureEnv completes for
  // all booted simulators, eliminating the race with launch-app.
  const ready = poll(true);

  // Subsequent polls are fire-and-forget.
  const interval = setInterval(() => poll(false).catch(() => {}), POLL_INTERVAL_MS);

  return { stop: () => clearInterval(interval), ready };
}
