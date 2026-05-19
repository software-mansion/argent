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

/**
 * Resolve (or re-resolve) the native-devtools service for a single UDID and
 * drive its env-init retry loop. Retries are bounded inside the api itself —
 * once `getInitFailure()?.givenUp` is true this is effectively a no-op, which
 * is how the watcher stops burning work on a persistently-broken simulator.
 */
async function tickUdid(registry: Registry, udid: string): Promise<void> {
  const ndRef = nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" });
  let api: NativeDevtoolsApi;
  try {
    api = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
  } catch {
    // The factory tolerates env-init failure, so resolveService should only
    // throw on structural issues (wrong platform, missing options). Either
    // way nothing useful to retry here.
    return;
  }
  // First resolution already attempted env setup inside the factory. If that
  // attempt failed and we haven't given up, drive another retry. The api
  // records attempts internally; once at the cap, ensureEnvReady short-circuits.
  const failure = api.getInitFailure();
  if (failure && !failure.givenUp) {
    await api.ensureEnvReady().catch(() => {});
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

    if (awaitInit) {
      // First poll: await all resolutions so the server is only marked ready
      // after every booted simulator has been seen at least once.
      await Promise.all(
        [...booted].map((udid) => {
          watchedUdids.add(udid);
          return tickUdid(registry, udid);
        })
      );
    } else {
      // Subsequent polls: fire-and-forget to avoid blocking the interval tick.
      for (const udid of booted) {
        watchedUdids.add(udid);
        tickUdid(registry, udid).catch(() => {});
      }
    }

    // Simulators that shut down: dispose service. Fresh state on re-boot.
    for (const udid of watchedUdids) {
      if (!booted.has(udid)) {
        watchedUdids.delete(udid);
        registry.disposeService(`${NATIVE_DEVTOOLS_NAMESPACE}:${udid}`).catch(() => {});
      }
    }
  }

  // First poll is awaited — server startup blocks until ensureEnv has been
  // attempted for all currently-booted simulators, eliminating the race with
  // launch-app for the success path.
  const ready = poll(true);

  // Subsequent polls are fire-and-forget.
  const interval = setInterval(() => poll(false).catch(() => {}), POLL_INTERVAL_MS);

  return { stop: () => clearInterval(interval), ready };
}
