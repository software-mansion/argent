import type { DeviceInfo, InvokeToolOptions, ToolCapability } from "@argent/registry";
import { resolveDevice } from "./device-info";
import { assertSupported } from "./capability";

/**
 * Build an `execute` function that resolves a `udid` parameter into a DeviceInfo,
 * asserts the tool's capability declaration covers it, and dispatches to the
 * matching per-platform handler.
 *
 * Cross-platform tools call this in their `ToolDefinition.execute` so the
 * resolveDevice + assertSupported + branch boilerplate is one line per tool
 * instead of five.
 *
 * `Services` is the shape of services the tool declares — typed so handlers
 * see real names (e.g. `services.simulatorServer`) instead of the raw
 * `Record<string, unknown>` the registry hands in.
 */
export function dispatchByPlatform<
  Services,
  Params extends { udid: string },
  Result,
>(opts: {
  toolId: string;
  capability: ToolCapability;
  ios: (services: Services, params: Params, device: DeviceInfo) => Promise<Result>;
  android: (services: Services, params: Params, device: DeviceInfo) => Promise<Result>;
}): (
  services: Record<string, unknown>,
  params: Params,
  options?: InvokeToolOptions
) => Promise<Result> {
  return async (services, params) => {
    const device = resolveDevice(params.udid);
    assertSupported(opts.toolId, opts.capability, device);
    const typedServices = services as unknown as Services;
    return device.platform === "ios"
      ? opts.ios(typedServices, params, device)
      : opts.android(typedServices, params, device);
  };
}
