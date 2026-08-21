import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import type { KeyboardParams, KeyboardResult } from "../types";
import { typeSimulatorServer } from "../simulator-server-keys";
import { typeTv } from "./tv";

// A tvOS sim classifies as platform "ios" by UDID shape, so this branch handles
// both iPhone/iPad (simulator-server typing) and Apple TV (focus-driven typing).
// TV is a `runtimeKind`, not a `platform`, so the kind is an async runtime probe.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    // `options` is forwarded, not dropped: it carries the framework abort signal,
    // and iOS typing is the one keyboard backend that both holds a per-device
    // queue and can run for minutes (see `typeSimulatorServer`).
    handler: async (_services, params, device, options) =>
      (await isTvOsSimulator(device.id))
        ? typeTv(registry, device, params)
        : typeSimulatorServer(registry, device, params, options?.signal),
  };
}

// Remote sims are always iOS (never tvOS), so skip the tvOS probe — which shells
// out to local `xcrun` and would fail on a non-macOS host anyway — and type
// straight over the simulator-server, whose blueprint routes an ios-remote
// device through the sim-remote MoQ transport.
export function makeIosRemoteImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device, options) =>
      typeSimulatorServer(registry, device, params, options?.signal),
  };
}
