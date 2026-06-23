import type { DeviceInfo, Registry } from "@argent/registry";
import { UnsupportedOperationError } from "../../../utils/capability";
import { resolveTvApi } from "../../tv/tv-service";
import type { KeyboardParams, KeyboardResult } from "../types";

// TV typing goes through the focus-driven tv-control backend (injected HID
// keyboard on Apple TV, `adb input text` on Android TV). Named keys are
// navigation on a TV, which belongs to `tv-remote` — so they're rejected here.
// Shared by the ios (Apple TV) and android (Android TV) branches.
export async function typeTv(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
): Promise<KeyboardResult> {
  if (params.key) {
    throw new UnsupportedOperationError(
      "keyboard",
      device,
      "named keys are not supported on a TV target — move focus with `tv-remote` " +
        "(up/down/left/right/select) instead"
    );
  }
  const text = params.text ?? "";
  if (text) {
    const api = await resolveTvApi(registry, device.id);
    await api.type(text);
  }
  return { typed: text, keys: text.length };
}
