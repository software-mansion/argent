import { FAILURE_CODES } from "@argent/registry";
import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../../utils/ios-device/app-session";
import { pressKeyboardReturn, typeText } from "../../../utils/ios-device/runner-commands";
import type { KeyboardParams, KeyboardResult } from "../types";

/**
 * Type into the focused element on a physical iOS device.
 * Only `enter` is available as a named key.
 */
export function makeIosDeviceImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    requires: ["xcrun"],
    handler: async (_services, params, device) => {
      const key = params.key?.trim().toLowerCase();

      // Gate on the raw key. A whitespace-only name would otherwise succeed as a no-op.
      if (params.key && key !== "enter") {
        throw new InvalidToolInputError(
          `Named key '${params.key}' is not supported on physical iOS devices: only 'enter'. ` +
            "Type text into the focused field, or use gesture-tap to press on-screen keys.",
          {
            error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
            failure_stage: "keyboard_named_key_ios_device",
            error_kind: "unsupported",
          }
        );
      }

      // Empty request is a documented no-op. Return before resolving the runner.
      if (!params.text && !key) {
        return {
          typed: "",
          keys: 0,
        };
      }

      const bundleId = requireCurrentIosDeviceApp(device.id);
      const ref = iosDeviceRunnerRef(device);
      const api = await registry.resolveService<IosDeviceRunnerApi>(ref.urn, ref.options);

      // XCTest types whole strings and has no per-keycode HID surface. delayMs is ignored.
      let keys = 0;
      let reactivated = false;

      if (params.text) {
        // Secret placeholders are already resolved by the execute wrapper.
        const typed = await typeText(api, bundleId, params.text);
        reactivated ||= typed.reactivated;
        keys += params.text.length;
      }

      if (key === "enter") {
        const pressed = await pressKeyboardReturn(api, bundleId);
        reactivated ||= pressed.reactivated;
        keys += 1;
      }

      return {
        typed: params.text ?? params.key ?? "",
        keys,
        ...(reactivated ? { reactivated: true as const } : {}),
      };
    },
  };
}
