import type {
  DeviceInfo,
  InvokeToolOptions,
  Platform,
  ToolCapability,
  ToolDependency,
} from "@argent/registry";
import type { MacosAppApi } from "../blueprints/macos-app";
import { isIosPhysicalDevice, resolveDevice } from "./device-info";
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
  HarmonyServices = unknown,
  IosDeviceServices = IosServices,
>(opts: {
  toolId: string;
  capability: ToolCapability;
  ios: PlatformImpl<IosServices, Params, Result>;
  android: PlatformImpl<AndroidServices, Params, Result>;
  iosRemote?: PlatformImpl<IosRemoteServices, Params, Result>;
  /**
   * Physical iOS device branch (`platform: "ios"`, `kind: "device"`). Optional
   * so simulator-only tools compile unchanged. It is checked BEFORE the plain
   * `ios` branch: a physical device must never fall through to the simulator
   * handler, whose services (simulator-server, simctl) do not exist for
   * hardware. Declared-but-unwired (capability says `apple: { device: true }`
   * with no branch here) throws `NotImplementedOnPlatformError` (501) so the
   * gap is a loud contributor hint, not a simulator-path misroute.
   */
  iosDevice?: PlatformImpl<IosDeviceServices, Params, Result>;
  chromium?: PlatformImpl<ChromiumServices, Params, Result>;
  vega?: PlatformImpl<VegaServices, Params, Result>;
  /** Optional like `vega`: a declared but unwired `harmony` throws 501. */
  harmony?: PlatformImpl<HarmonyServices, Params, Result>;
  /** Native Mac app branch (`macos-app-<bundle id>`); optional like `vega`. */
  macos?: PlatformImpl<{ macosApp: MacosAppApi }, Params, Result>;
}): (
  services: Record<string, unknown>,
  params: Params,
  options?: InvokeToolOptions
) => Promise<Result> {
  return async (services, params, invokeOptions) => {
    const device = resolveDevice(params.udid);
    assertSupported(opts.toolId, opts.capability, device);
    if (isIosPhysicalDevice(device)) {
      if (!opts.iosDevice) {
        throw new NotImplementedOnPlatformError({
          toolId: opts.toolId,
          platform: "ios",
          // The class's stock message derives platforms/ios.ts and says to add
          // a capability block, both wrong for hardware, so the hint corrects.
          hint:
            `For physical iOS devices, implement ` +
            `tools/${opts.toolId}/platforms/ios-device.ts instead; the capability ` +
            `block already exists.`,
        });
      }
      if (opts.iosDevice.requires?.length) {
        await ensureDeps(opts.iosDevice.requires);
      }
      return opts.iosDevice.handler(
        services as unknown as IosDeviceServices,
        params,
        device,
        invokeOptions
      );
    }
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
    // Declared but unwired, these throw 501 rather than fall through to another platform.
    const run = async <S>(
      impl: PlatformImpl<S, Params, Result> | undefined,
      platform: Platform
    ) => {
      if (!impl) throw new NotImplementedOnPlatformError({ toolId: opts.toolId, platform });
      if (impl.requires?.length) await ensureDeps(impl.requires);
      return impl.handler(services as unknown as S, params, device, invokeOptions);
    };
    if (device.platform === "vega") return run(opts.vega, "vega");
    if (device.platform === "harmony") return run(opts.harmony, "harmony");
    if (device.platform === "macos") return run(opts.macos, "macos");
    return run(opts.chromium, "chromium");
  };
}
