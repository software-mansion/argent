import type { DeviceInfo, Registry } from "@argent/registry";
import { axServiceRef, type AXServiceApi } from "../blueprints/ax-service";
import { isTvOsSimulator } from "./ios-devices";
import { settleWithin, sleepOrAbort } from "./timing";

/**
 * How long launch-app and restart-app wait, once `simctl launch` returns, for
 * the accessibility service to name the app they started as the one in front.
 * On an idle host it names it within moments; on a busy one it took over 3.5 s
 * (iOS 27.0, host load average in the hundreds). An app that never comes to the
 * front, such as one that crashes at launch, costs the launch this much.
 */
const IN_FRONT_TIMEOUT_MS = 5_000;
const IN_FRONT_POLL_MS = 100;

/**
 * Wait until the accessibility service names `bundleId` as the app in front of
 * an iOS simulator, for at most {@link IN_FRONT_TIMEOUT_MS}.
 *
 * `simctl launch` returns before the app is up, and until it is, the service
 * still resolves the app that was in front. Whatever is read through it then
 * is that app's: the element tree, and the interface orientation that
 * captures, frames and touches are turned by (`ios-ui-orientation.ts`). A
 * portrait-only app started from a landscape app was captured sideways, with
 * the landscape app's tree. Returning once the service names the new app keeps
 * the next tool call from reading the old one.
 *
 * Never throws: a service that cannot be asked ends the wait, and the reads
 * after it report that failure themselves.
 */
export async function awaitIosAppInFront(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + IN_FRONT_TIMEOUT_MS;
  const remaining = () => deadline - Date.now();
  if (signal?.aborted) return;
  // A cold runtime lookup can itself need `simctl list`. An Apple TV runs no AX service.
  const tv = await settleWithin(
    isTvOsSimulator(device.id).catch(() => false),
    remaining(),
    signal
  );
  if (tv.type !== "value" || tv.value || remaining() <= 0) return;
  const ref = axServiceRef(device);
  const service = await settleWithin(
    registry.resolveService<AXServiceApi>(ref.urn, ref.options),
    remaining(),
    signal
  );
  if (service.type !== "value") return;
  const frontBundleId = async () => (await service.value.foregroundApp()).bundleId;
  while (remaining() > 0) {
    const front = await settleWithin(frontBundleId(), remaining(), signal);
    if (front.type !== "value" || front.value === bundleId) return;
    const delay = Math.min(IN_FRONT_POLL_MS, remaining());
    if (delay <= 0 || !(await sleepOrAbort(delay, signal))) return;
  }
}
