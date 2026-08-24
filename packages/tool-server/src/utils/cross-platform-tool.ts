import type {
  DeviceInfo,
  InvokeToolOptions,
  ToolCapability,
  ToolDependency,
} from "@argent/registry";
import { resolveDevice } from "./device-info";
import { assertSupported, NotImplementedOnPlatformError } from "./capability";
import { ensureDeps } from "./check-deps";

/**
 * One platform branch of a cross-platform tool. Only the resolved branch's
 * `requires` is probed, so an iOS-only host never trips an `adb` check; use
 * `ToolDefinition.requires` for binaries every invocation needs.
 */
export interface PlatformImpl<Services, Params, Result> {
  /** Host binaries this branch needs, probed before `handler` runs. */
  requires?: ToolDependency[];
  handler: (
    services: Services,
    params: Params,
    device: DeviceInfo,
    options?: InvokeToolOptions
  ) => Promise<Result>;
}

/**
 * Build a `ToolDefinition.execute` that resolves `udid` to a device, asserts the
 * tool's capability covers it, probes the matching branch's host binaries, and
 * dispatches to its handler.
 *
 * `Services` is the tool's own service shape, so handlers see real names (e.g.
 * `services.simulatorServer`) instead of the `Record<string, unknown>` the
 * registry hands in.
 */
export function dispatchByPlatform<
  IosServices,
  AndroidServices,
  Params extends { udid: string },
  Result,
  ChromiumServices = Record<string, unknown>,
  VegaServices = unknown,
  IosRemoteServices = IosServices,
>(opts: {
  toolId: string;
  capability: ToolCapability;
  ios: PlatformImpl<IosServices, Params, Result>;
  android: PlatformImpl<AndroidServices, Params, Result>;
  iosRemote?: PlatformImpl<IosRemoteServices, Params, Result>;
  chromium?: PlatformImpl<ChromiumServices, Params, Result>;
  vega?: PlatformImpl<VegaServices, Params, Result>;
}): (
  services: Record<string, unknown>,
  params: Params,
  options?: InvokeToolOptions
) => Promise<Result> {
  return async (services, params, invokeOptions) => {
    const device = resolveDevice(params.udid);
    assertSupported(opts.toolId, opts.capability, device);
    if (device.platform === "ios") {
      if (opts.ios.requires?.length) {
        await ensureDeps(opts.ios.requires);
      }
      return opts.ios.handler(services as unknown as IosServices, params, device, invokeOptions);
    }
    if (device.platform === "ios-remote") {
      if (!opts.iosRemote) {
        throw new Error(
          `Tool '${opts.toolId}' declares ios-remote capability but has no iosRemote branch. ` +
            `Add an iosRemote PlatformImpl to dispatchByPlatform().`
        );
      }
      if (opts.iosRemote.requires?.length) {
        await ensureDeps(opts.iosRemote.requires);
      }
      return opts.iosRemote.handler(
        services as unknown as IosRemoteServices,
        params,
        device,
        invokeOptions
      );
    }
    if (device.platform === "android") {
      if (opts.android.requires?.length) {
        await ensureDeps(opts.android.requires);
      }
      return opts.android.handler(
        services as unknown as AndroidServices,
        params,
        device,
        invokeOptions
      );
    }
    if (device.platform === "vega") {
      if (!opts.vega) {
        throw new NotImplementedOnPlatformError({ toolId: opts.toolId, platform: "vega" });
      }
      if (opts.vega.requires?.length) {
        await ensureDeps(opts.vega.requires);
      }
      return opts.vega.handler(services as unknown as VegaServices, params, device, invokeOptions);
    }
    // chromium
    if (!opts.chromium) {
      throw new NotImplementedOnPlatformError({
        toolId: opts.toolId,
        platform: "chromium",
      });
    }
    if (opts.chromium.requires?.length) {
      await ensureDeps(opts.chromium.requires);
    }
    return opts.chromium.handler(
      services as unknown as ChromiumServices,
      params,
      device,
      invokeOptions
    );
  };
}
