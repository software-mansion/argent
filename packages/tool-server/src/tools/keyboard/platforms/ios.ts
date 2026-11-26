import type { DeviceInfo, Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isTvOsSimulator } from "../../../utils/ios-devices";
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
  const { result, readback } = await typeWithReadback(registry, device, params.text ?? "", () =>
    typeSimulatorServer(registry, device, params)
  );
  return readback ? { ...result, ...readback } : result;
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
    handler: async (_services, params, device) => typeAndReadBack(registry, device, params),
  };
}
