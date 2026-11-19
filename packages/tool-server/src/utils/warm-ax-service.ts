import { ServiceState, parseURN, type Registry } from "@argent/registry";
import { axServiceRef } from "../blueprints/ax-service";
import { SIMULATOR_SERVER_NAMESPACE } from "../blueprints/simulator-server";
import { resolveDevice } from "./device-info";
import { isExternalId } from "./external-devices";

function localIosSimulatorOf(urn: string) {
  const { namespace, payload } = parseURN(urn);
  if (namespace !== SIMULATOR_SERVER_NAMESPACE) return undefined;
  const device = resolveDevice(payload);
  if (device.platform !== "ios" || device.kind !== "simulator" || isExternalId(device.id)) {
    return undefined;
  }
  return device;
}

/** Starts a local iOS simulator's ax-service in the background once its simulator-server is up. */
export function warmAxServiceOnSimulatorStart(registry: Registry): void {
  registry.events.on("serviceStateChange", (urn, _from, to) => {
    if (to !== ServiceState.RUNNING) return;
    const device = localIosSimulatorOf(urn);
    if (!device) return;
    const ref = axServiceRef(device);
    queueMicrotask(() => {
      registry.resolveService(ref.urn, ref.options).catch(() => {});
    });
  });
}
