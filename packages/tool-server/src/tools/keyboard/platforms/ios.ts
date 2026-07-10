import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import type { KeyboardParams, KeyboardResult } from "../types";
import { typeSimulatorServer } from "../simulator-server-keys";
import { typeTv } from "./tv";
import {
  physicalIosAutomationRef,
  type PhysicalIosAutomationApi,
} from "../../../blueprints/physical-ios-automation";
import { isPhysicalIos } from "../../../utils/device-info";

// A tvOS sim classifies as platform "ios" by UDID shape, so this branch handles
// both iPhone/iPad (simulator-server typing) and Apple TV (focus-driven typing).
// TV is a `runtimeKind`, not a `platform`, so the kind is an async runtime probe.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device) => {
      if (isPhysicalIos(device)) {
        const ref = physicalIosAutomationRef(device);
        const api = await registry.resolveService<PhysicalIosAutomationApi>(ref.urn, ref.options);
        if (params.key) await api.pressKey(params.key.toLowerCase());
        if (params.text) await api.typeText(params.text, params.delayMs);
        return {
          typed: params.text ?? params.key ?? "",
          keys: (params.key ? 1 : 0) + (params.text?.length ?? 0),
        };
      }
      return (await isTvOsSimulator(device.id))
        ? typeTv(registry, device, params)
        : typeSimulatorServer(registry, device, params);
    },
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
    handler: async (_services, params, device) => typeSimulatorServer(registry, device, params),
  };
}
