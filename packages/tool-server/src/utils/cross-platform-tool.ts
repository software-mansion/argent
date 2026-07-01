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
 * One platform branch of a cross-platform tool: its host-binary dependencies
 * plus the handler that runs when the resolved device matches this platform.
 *
 * Co-locating `requires` with `handler` keeps each platform file self-contained
 * — when you read `platforms/ios.ts` you see exactly what binaries it shells
 * out to, not a global declaration two levels up. `dispatchByPlatform` wires
 * the right branch's `requires` into the preflight before the handler runs,
 * so an iOS-only environment never trips an `adb` check, and vice versa.
 *
 * Use the `ToolDefinition.requires` field instead when a binary is needed by
 * *every* invocation regardless of which platform branch fires (rare — usually
 * only true for analysis / no-device tools).
 */
export interface PlatformImpl<Services, Params, Result> {
  /** Host binaries this branch needs. Probed via `ensureDeps` before `handler` runs. */
  requires?: ToolDependency[];
  /** Implementation function. Receives typed services, params, the resolved device, and invoke options. */
  handler: (
    services: Services,
    params: Params,
    device: DeviceInfo,
    options?: InvokeToolOptions
  ) => Promise<Result>;
}

/**
 * Build an `execute` function that resolves a `udid` parameter into a DeviceInfo,
 * asserts the tool's capability declaration covers it, runs the resolved
 * platform branch's host-binary preflight, and dispatches to its handler.
 *
 * Cross-platform tools call this in their `ToolDefinition.execute` so the
 * resolveDevice + assertSupported + dep preflight + branch boilerplate is
 * one line per tool instead of ten.
 *
 * `Services` is the shape of services the tool declares — typed so handlers
 * see real names (e.g. `services.simulatorServer`) instead of the raw
 * `Record<string, unknown>` the registry hands in.
 *
 * The `chromium` branch is optional. When omitted, a chromium device triggers
 * `NotImplementedOnPlatformError` — the capability gate normally fires first,
 * so this only matters for tools that declare chromium support without wiring
 * a handler.
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
  /**
   * Optional ios-remote branch. When omitted, an ios-remote device will hit
   * `assertSupported` and fail there if the tool's capability matrix doesn't
   * include `appleRemote` — so adding ios-remote support is two changes (this
   * branch + the matrix), and the absence of either is a clean 400.
   */
  iosRemote?: PlatformImpl<IosRemoteServices, Params, Result>;
  chromium?: PlatformImpl<ChromiumServices, Params, Result>;
  /**
   * Vega (Fire TV) branch. Optional so existing iOS/Android-only tools compile
   * unchanged. When a tool's capability declares `vega` support but no `vega`
   * branch is wired here, a Vega device dispatch throws
   * `NotImplementedOnPlatformError` (501) rather than silently falling through.
   */
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
