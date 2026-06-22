import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isAndroidTv } from "../../../utils/adb";
import type { ButtonParams, ButtonResult } from "../types";
import { pressHardwareButton } from "../hardware-button";
import { pressTvButton } from "./tv";

// An Android TV emulator classifies as platform "android" by serial shape, so
// this branch handles both phones/tablets (hardware buttons) and Android TV
// (remote buttons → adb keyevents via the tv-control backend). TV is a
// `runtimeKind`, not a `platform`, so the kind is an async runtime probe.
export function makeAndroidImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, ButtonParams, ButtonResult> {
  return {
    handler: async (_services, params, device) =>
      (await isAndroidTv(device.id))
        ? pressTvButton(registry, device, params.button)
        : pressHardwareButton(registry, device, params.button),
  };
}
