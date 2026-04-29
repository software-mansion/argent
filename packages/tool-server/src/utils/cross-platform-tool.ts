import type {
  DeviceInfo,
  InvokeToolOptions,
  ServiceRef,
  ToolCapability,
  ToolDependency,
} from "@argent/registry";
import { resolveDevice } from "./device-info";
import { assertSupported } from "./capability";
import { ensureDeps } from "./check-deps";

/**
 * One platform branch of a cross-platform tool: its host-binary dependencies,
 * the services it depends on, and the handler that runs when the resolved
 * device matches this platform.
 *
 * Co-locating `requires`, `services` and `handler` keeps each platform file
 * self-contained — when you read `platforms/ios.ts` you see exactly what
 * binaries it shells out to and what registry services it needs, not a
 * global declaration two levels up. `dispatchByPlatform` wires the right
 * branch's `requires` into the preflight and the right branch's `services`
 * into the registry, so an iOS-only environment never trips an `adb` check
 * or spins up an Android-only blueprint, and vice versa.
 *
 * Use the `ToolDefinition.requires` field instead when a binary is needed by
 * *every* invocation regardless of which platform branch fires (rare — usually
 * only true for analysis / no-device tools).
 */
export interface PlatformImpl<Services, Params, Result> {
  /** Host binaries this branch needs. Probed via `ensureDeps` before `handler` runs. */
  requires?: ToolDependency[];
  /**
   * Optional per-platform service-URN map. The dispatch helper exposes a
   * combined `services()` that picks the matching branch's declaration based
   * on the resolved device, so the tool's `ToolDefinition.services` is just
   * a passthrough.
   */
  services?: (params: Params) => Record<string, ServiceRef>;
  /** Implementation function. Receives typed services, params, the resolved device, and invoke options. */
  handler: (
    services: Services,
    params: Params,
    device: DeviceInfo,
    options?: InvokeToolOptions
  ) => Promise<Result>;
}

/**
 * Object returned by `dispatchByPlatform` — a tool wires both into its
 * `ToolDefinition` so the platform decision lives in exactly one place
 * (this helper) and the rest of the definition has no per-platform
 * branching.
 */
export interface CrossPlatformDispatch<Params, Result> {
  /**
   * Builds the alias→URN map by delegating to the matching branch's
   * `PlatformImpl.services`. Returns `{}` if neither branch declares any.
   * Wire as `ToolDefinition.services`.
   */
  services: (params: Params) => Record<string, ServiceRef>;
  /**
   * Runs `assertSupported`, the matching branch's host-binary preflight,
   * and dispatches to the handler. Wire as `ToolDefinition.execute`.
   */
  execute: (
    services: Record<string, unknown>,
    params: Params,
    options?: InvokeToolOptions
  ) => Promise<Result>;
}

/**
 * Build the `services` and `execute` functions for a cross-platform tool's
 * `ToolDefinition` from a per-platform `PlatformImpl` pair.
 *
 * The platform decision is taken once — either by `device(params)` if the
 * caller provides one (e.g. `boot-device`, where the platform comes from
 * which optional input is set rather than from a udid) or by the default
 * `resolveDevice(params.udid)` for the common case. That decision is then
 * propagated as the `device` argument into the handler, so the inside of a
 * tool never re-classifies.
 */
export function dispatchByPlatform<Services, Params extends { udid: string }, Result>(opts: {
  toolId: string;
  capability: ToolCapability;
  ios: PlatformImpl<Services, Params, Result>;
  android: PlatformImpl<Services, Params, Result>;
}): CrossPlatformDispatch<Params, Result>;
export function dispatchByPlatform<Services, Params, Result>(opts: {
  toolId: string;
  capability: ToolCapability;
  device: (params: Params) => DeviceInfo;
  ios: PlatformImpl<Services, Params, Result>;
  android: PlatformImpl<Services, Params, Result>;
}): CrossPlatformDispatch<Params, Result>;
export function dispatchByPlatform<Services, Params, Result>(opts: {
  toolId: string;
  capability: ToolCapability;
  device?: (params: Params) => DeviceInfo;
  ios: PlatformImpl<Services, Params, Result>;
  android: PlatformImpl<Services, Params, Result>;
}): CrossPlatformDispatch<Params, Result> {
  const resolveD = (params: Params): DeviceInfo =>
    opts.device ? opts.device(params) : resolveDevice((params as { udid: string }).udid);

  const pickImpl = (params: Params): PlatformImpl<Services, Params, Result> => {
    const device = resolveD(params);
    return device.platform === "ios" ? opts.ios : opts.android;
  };

  return {
    services: (params) => {
      const impl = pickImpl(params);
      return impl.services?.(params) ?? {};
    },
    execute: async (services, params, invokeOptions) => {
      const device = resolveD(params);
      assertSupported(opts.toolId, opts.capability, device);
      const impl = device.platform === "ios" ? opts.ios : opts.android;
      if (impl.requires?.length) {
        await ensureDeps(impl.requires);
      }
      const typedServices = services as unknown as Services;
      return impl.handler(typedServices, params, device, invokeOptions);
    },
  };
}
