import * as fs from "node:fs";
import type { Registry } from "@argent/registry";
import {
  NATIVE_DEVTOOLS_NAMESPACE,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../blueprints/native-devtools";
import { externalClaimForNativeId } from "./external-devices";
import {
  configuredAdditionalDeviceSets,
  rememberDeviceSet,
  simctlPrefix,
  type DeviceSetPath,
} from "./ios-device-sets";
import { execSimctl, SimctlTimeoutError } from "./simctl-exec";

const POLL_INTERVAL_MS = 10_000;
/** Ceiling, in ticks, on the polls skipped while `simctl` keeps timing out (5 min). */
const MAX_BACKOFF_TICKS = 29;

async function getBootedUdidsInSet(
  deviceSet: DeviceSetPath,
  signal: AbortSignal
): Promise<Set<string>> {
  const stdout = await execSimctl([...simctlPrefix(deviceSet), "list", "devices", "--json"], {
    signal,
  });
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
 * missing is not queried — querying would make simctl materialize it. Every
 * set's call settles before this does, so a tick never leaves one running, and
 * a timeout wins over other failures so the caller backs off.
 */
async function getBootedUdids(signal: AbortSignal): Promise<Set<string>> {
  const sets: DeviceSetPath[] = [
    null,
    ...configuredAdditionalDeviceSets().filter((p) => fs.existsSync(p)),
  ];
  const perSet = await Promise.allSettled(sets.map((set) => getBootedUdidsInSet(set, signal)));
  const failures = perSet.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  if (failures.length) {
    throw failures.find((err) => err instanceof SimctlTimeoutError) ?? failures[0];
  }
  return new Set(perSet.flatMap((r) => (r.status === "fulfilled" ? [...r.value] : [])));
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

export function startSimulatorWatcher(registry: Registry): {
  stop: () => void;
  ready: Promise<void>;
} {
  const trackedServices = new Map<string, NativeDevtoolsApi>();
  /**
   * Skipped UDIDs, so the reason is logged once per boot rather than per tick.
   */
  const reportedSkips = new Set<string>();
  /** Kills any `simctl` still running when the watcher stops. */
  const stopController = new AbortController();
  /**
   * Polls in a row whose `simctl` timed out. Each one doubles the ticks skipped
   * before the next attempt, since every attempt restarts the hung `xcodebuild
   * -runFirstLaunch`; the first also logs the hint, once per outage. Counted in
   * ticks rather than wall-clock time, so a clock change cannot stretch it.
   */
  let consecutiveTimeouts = 0;
  let ticksToSkip = 0;

  /**
   * Split the booted set into the simulators the watcher may drive and the ones
   * a provider claims.
   *
   * `ours` drops the claimed simulators whose provider withheld
   * `native-devtools`. The capability gate would refuse them anyway, but
   * resolving a service that throws on every tick would fill the registry with
   * error entries. This way the watcher never asks.
   *
   * `claimed` holds every claim, granted or not, because what a claim changes
   * is who owns the injection; and that is true of a granted one too. A granted
   * claim stays in `ours` as well, the watcher still resolves a service for it,
   * just one that attaches to the provider's agent instead of arming its own.
   */
  function withoutForeignSimulators(booted: Set<string>): {
    ours: Set<string>;
    claimed: Set<string>;
  } {
    const ours = new Set<string>();
    const claimed = new Set<string>();

    for (const udid of booted) {
      const claim = externalClaimForNativeId(udid);

      if (!claim) {
        reportedSkips.delete(udid);
        ours.add(udid);
        continue;
      }

      claimed.add(udid);

      if (claim.capabilities.has("native-devtools")) {
        reportedSkips.delete(udid);
        ours.add(udid);
        continue;
      }

      if (!reportedSkips.has(udid)) {
        reportedSkips.add(udid);
        process.stderr.write(
          `[simulator-watcher] skipping ${udid}: ${claim.provider.name} offers it without the ` +
            `'native-devtools' capability, so argent leaves its devtools environment alone\n`
        );
      }
    }

    for (const udid of reportedSkips) {
      if (!booted.has(udid)) reportedSkips.delete(udid);
    }

    return { ours, claimed };
  }

  /**
   * Give a newly claimed simulator's devtools environment back to its provider.
   *
   * A provider that boots a simulator arms its own injection and then publishes
   * the descriptor, so a tick landing in between finds an unclaimed simulator
   * and arms over it. Once the claim appears the environment is the provider's
   * business, whatever it granted/ `NATIVE_DEVTOOLS_IOS_CDP_SOCKET` names our
   * socket and launchd holds it for the rest of the boot, so the provider's own
   * agent would dial us rather than the provider.
   *
   * Letting go of the service is not enough on its own, hence the withdrawal.
   * Dropping it afterwards is what makes the grant's own answer apply. A
   * granted claim re-resolves on the pass below into attach mode, where the
   * provider owns the injection and we borrow its agent and an ungranted one is
   * simply not ours to hold any more.
   *
   * Best-effort and one attempt. The UDID leaves `trackedServices` either way,
   * so there is nothing to retry against and a failure only leaves what was
   * already there.
   */
  async function handBackClaimed(claimed: Set<string>): Promise<void> {
    for (const udid of claimed) {
      const service = trackedServices.get(udid);
      /*
       * `armsEnv` is false for a service that already attaches to a provider,
       * which is every service resolved after the claim was published. Only one
       * resolved before it has anything of ours on the device.
       */
      if (!service?.armsEnv) continue;

      trackedServices.delete(udid);

      await service.withdrawEnv().catch((err: unknown) => {
        process.stderr.write(
          `[simulator-watcher] could not hand ${udid}'s devtools environment back to its ` +
            `provider: ${String(err)}\n`
        );
      });

      await registry.disposeService(`${NATIVE_DEVTOOLS_NAMESPACE}:${udid}`).catch(() => {});
    }
  }

  async function poll(shouldBlockUntilSettled: boolean): Promise<void> {
    let booted: Set<string>;
    let claimed: Set<string>;
    try {
      ({ ours: booted, claimed } = withoutForeignSimulators(
        await getBootedUdids(stopController.signal)
      ));
    } catch (err) {
      if (err instanceof SimctlTimeoutError) {
        consecutiveTimeouts += 1;
        ticksToSkip = Math.min(2 ** consecutiveTimeouts - 1, MAX_BACKOFF_TICKS);
        if (consecutiveTimeouts === 1) {
          process.stderr.write(
            `[simulator-watcher] ${err.message}; retrying with backoff until it does. ` +
              `If Xcode was just updated, open Xcode once or run \`sudo xcodebuild -runFirstLaunch\`.\n`
          );
        }
      }
      // xcrun unavailable or transient error — skip this tick
      return;
    }
    consecutiveTimeouts = 0;

    /**
     * Before the init pass, so a granted claim re-resolves into attach mode on
     * the same tick rather than staying armed for another ten seconds.
     */
    await handBackClaimed(claimed);

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

    /**
     * Shut down, so there is no environment left to hand anywhere, launchd took
     * it with the boot. A simulator that is merely claimed left `booted` via
     * `handBackClaimed` above, which withdraws first.
     */
    for (const udid of [...trackedServices.keys()]) {
      if (booted.has(udid)) continue;
      trackedServices.delete(udid);
      registry.disposeService(`${NATIVE_DEVTOOLS_NAMESPACE}:${udid}`).catch(() => {});
    }
  }

  // Awaited: the server does not bind until ensureEnv has been attempted for
  // every booted simulator, so launch-app cannot race it.
  // The simctl call is bounded, so this resolves even when simctl hangs.
  const ready = poll(true);

  // A tick that lands while the previous poll is still running, or inside the
  // backoff after a timeout, is skipped, so a slow simctl never has more than one
  // call in flight. Every await in a poll is bounded, so neither holds forever.
  let inFlight: Promise<void> | null = ready.catch(() => {}).finally(() => (inFlight = null));
  const interval = setInterval(() => {
    if (inFlight) return;
    if (ticksToSkip > 0) {
      ticksToSkip -= 1;
      return;
    }
    inFlight = poll(false)
      .catch(() => {})
      .finally(() => (inFlight = null));
  }, POLL_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(interval);
      stopController.abort();
    },
    ready,
  };
}
