import type { Registry } from "@argent/registry";
import { axServiceRef, type AXServiceApi } from "../blueprints/ax-service";
import { resolveDevice } from "./device-info";
import { isExternalId } from "./external-devices";
import { isTvOsSimulator } from "./ios-devices";

export async function isLocalMobileSimulator(udid: string): Promise<boolean> {
  const device = resolveDevice(udid);
  if (device.platform !== "ios" || device.kind !== "simulator" || isExternalId(udid)) {
    return false;
  }
  return !(await isTvOsSimulator(udid));
}

/** Starts the simulator's ax-service and reads the screen once, discarding the read. */
export async function warmAxService(registry: Registry, udid: string): Promise<void> {
  const ref = axServiceRef(resolveDevice(udid));
  const api = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);
  await api.describe();
}
