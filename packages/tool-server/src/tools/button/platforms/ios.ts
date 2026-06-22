import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import type { ButtonParams, ButtonResult } from "../types";
import { pressHardwareButton } from "../hardware-button";
import { pressTvButton } from "./tv";

// A tvOS sim classifies as platform "ios" by UDID shape, so this branch handles
// both iPhone/iPad (hardware buttons) and Apple TV (remote buttons). TV is a
// `runtimeKind`, not a `platform`, so the kind is an async runtime probe.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, ButtonParams, ButtonResult> {
  return {
    handler: async (_services, params, device) =>
      (await isTvOsSimulator(device.id))
        ? pressTvButton(registry, device, params.button)
        : pressHardwareButton(registry, device, params.button),
  };
}
