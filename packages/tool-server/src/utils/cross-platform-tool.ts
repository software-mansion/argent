import type {
  DeviceInfo,
  InvokeToolOptions,
  ToolCapability,
  ToolDependency,
} from "@argent/registry";
import { resolveDevice } from "./device-info";
import { assertSupported } from "./capability";
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
 */
export function dispatchByPlatform<
  IosServices,
  AndroidServices,
  Params extends { udid: string },
  Result,
>(opts: {
  toolId: string;
  capability: ToolCapability;
  ios: PlatformImpl<IosServices, Params, Result>;
  android: PlatformImpl<AndroidServices, Params, Result>;
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
      return opts.ios.handler(
        services as unknown as IosServices,
        params,
        device,
        invokeOptions
      );
    }
    if (opts.android.requires?.length) {
      await ensureDeps(opts.android.requires);
    }
    return opts.android.handler(
      services as unknown as AndroidServices,
      params,
      device,
      invokeOptions
    );
  };
}
