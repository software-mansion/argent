import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 10_000;

/**
 * Most polls to sit out after a lent simulator's attach keeps failing, about
 * five minutes. Each failure in a row doubles the wait up to this.
 */
const MAX_ATTACH_BACKOFF_POLLS = 30;

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
): Promise<boolean> {
  // tvOS sims are also platform "ios" (classified by UDID shape) and
  // native-devtools covers them: its ensureEnv picks the TVOSSIMULATOR dylib
  // slice.
  const ndRef = nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" });
  try {
    const service = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
    trackedServices.set(udid, service);
    return true;
  } catch {
    // Factory tolerates env-init failure; a throw here is structural.
    return false;
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

  /**
   * Lent simulators whose attach failed, with the failures in a row and the
   * polls left to sit out. A provider that accepts and then hangs up or one
   * that stopped listening, would otherwise be dialled on every poll and log a
   * service error each time. The watcher only warms the connection up and a
   * tool call still attaches on its own, so waiting longer costs nothing.
   */
  const attachBackoff = new Map<string, { failures: number; pollsLeft: number }>();

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
      ({ ours: booted, claimed } = withoutForeignSimulators(await getBootedUdids()));
    } catch {
      // xcrun unavailable or transient error — skip this tick
      return;
    }

    /**
     * Before the init pass, so a granted claim re-resolves into attach mode on
     * the same tick rather than staying armed for another ten seconds.
     */
    await handBackClaimed(claimed);

    for (const udid of attachBackoff.keys()) {
      if (!booted.has(udid) || !claimed.has(udid)) attachBackoff.delete(udid);
    }

    const newUdids = [...booted].filter((udid) => {
      if (trackedServices.has(udid)) return false;

      const backoff = attachBackoff.get(udid);

      if (backoff && backoff.pollsLeft > 0) {
        backoff.pollsLeft -= 1;
        return false;
      }

      return true;
    });

    const pendingAttempts: Promise<unknown>[] = newUdids.map(async (udid) => {
      const attached = await initUdid(registry, udid, trackedServices);

      if (!claimed.has(udid)) return;

      if (attached) {
        attachBackoff.delete(udid);
        return;
      }

      const failures = (attachBackoff.get(udid)?.failures ?? 0) + 1;

      attachBackoff.set(udid, {
        failures,
        pollsLeft: Math.min(2 ** (failures - 1), MAX_ATTACH_BACKOFF_POLLS),
      });
    });

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
  const ready = poll(true);

  const interval = setInterval(() => poll(false).catch(() => {}), POLL_INTERVAL_MS);

  return { stop: () => clearInterval(interval), ready };
}
