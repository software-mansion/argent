import { FAILURE_CODES } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError, UnsupportedOperationError } from "../../../utils/capability";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import { isRemoteTvOsSimulator } from "../../../utils/sim-remote";
import { fillIos } from "../../fill/ios";
import { charToKeyPress } from "../key-codes";
import type { KeyboardParams, KeyboardResult } from "../types";
import { typeSimulatorServer } from "../simulator-server-keys";
import { typeWithReadback } from "../ios-readback";
import { typeTv } from "./tv";

/** HID keys, then a read-back of the field where one can tell (../ios-readback.ts). */
async function typeAndReadBack(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
): Promise<KeyboardResult> {
  if (params.clear) {
    if (params.text) {
      // Validate up front so un-typeable text does not clear the field before failing.
      for (const char of params.text) {
        if (!charToKeyPress(char)) {
          throw new InvalidToolInputError(`No keycode for character "${char}"`, {
            error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
            failure_stage: "keyboard_char_simulator",
            error_kind: "unsupported",
          });
        }
      }
    }
    await fillIos(registry, device, "");
    if (!params.text && !params.key) {
      return { typed: "", keys: 0, cleared: true };
    }
  }
  const { result, readback } = await typeWithReadback(registry, device, params.text ?? "", () =>
    typeSimulatorServer(registry, device, params)
  );
  return {
    ...result,
    ...(params.clear ? { cleared: true as const } : {}),
    ...(readback ?? {}),
  };
}

// A tvOS sim is `platform: "ios"` by UDID shape; the TV/mobile split lives in
// `runtimeKind`, which only an async runtime probe can resolve.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device) =>
      (await isTvOsSimulator(device.id))
        ? typeTv(registry, device, params)
        : typeAndReadBack(registry, device, params),
  };
}

export function makeIosRemoteImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device) => {
      if (params.clear && (await isRemoteTvOsSimulator(device.id))) {
        throw new UnsupportedOperationError(
          "keyboard",
          device,
          "clearing a field with `clear: true` is not supported on a TV target"
        );
      }
      return typeAndReadBack(registry, device, params);
    },
  };
}
