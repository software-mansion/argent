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
    handler: async (_services, params, device) =>
      (await isTvOsSimulator(device.id))
        ? typeTv(registry, device, params)
        : typeSimulatorServer(registry, device, params),
  };
}
