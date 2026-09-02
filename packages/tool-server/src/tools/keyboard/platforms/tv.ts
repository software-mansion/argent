import type { DeviceInfo, Registry } from "@argent/registry";
import { UnsupportedOperationError } from "../../../utils/capability";
import { resolveTvApi } from "../../tv/tv-service";
import { CLEAR_KEY_PAIRS } from "../key-codes";
import { abandonedClearError } from "../simulator-server-keys";
import type { KeyboardParams, KeyboardResult } from "../types";

// Shared by the ios (Apple TV) and android (Android TV) branches, and reached
// only for a target the TV backend can actually drive — which a sim-remote one
// is not, so `platforms/ios.ts` refuses those before they get here rather than
// resolving a service that cannot exist. Named keys are navigation on a TV,
// which belongs to `tv-remote`, so they are rejected.
export async function typeTv(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  if (params.key) {
    throw new UnsupportedOperationError(
      "keyboard",
      device,
      "named keys are not supported on a TV target — move focus with `tv-remote` " +
        "(up/down/left/right/select) instead"
    );
  }
  if (params.clear === true) {
    // Both TV backends send the same burst the phone ones do —
    // `CLEAR_KEY_PAIRS` backspaces interleaved with as many forward-deletes —
    // over the channel each already types through: the injected HID daemon on
    // Apple TV (`blueprints/tv-control.ts`), `adb shell input keyevent` on
    // Android TV (`blueprints/android-tv-control.ts`, the same command the
    // phone path issues).
    //
    // Nothing is read back on either — a TV exposes no field value through
    // these channels — so `cleared` reports the burst as SENT and no
    // `clearVerified` is added, exactly as on iOS and Android.
    const api = await resolveTvApi(registry, device.id);
    const keys = await api.clear(signal);
    // A burst the caller abandoned FAILS rather than returning a short success,
    // for the reason `abandonedClearError` gives: a half-emptied field reported
    // as a completed step is the one state `cleared` must not be claimed for.
    // Same rule as ../simulator-server-keys.ts, and the same wording the adb
    // backends already use.
    if (keys < CLEAR_KEY_PAIRS * 2) {
      throw abandonedClearError(device.id, keys, "keyboard_clear_tv_abandoned");
    }
    return { typed: "", keys, cleared: true };
  }
  const text = params.text ?? "";
  if (text) {
    const api = await resolveTvApi(registry, device.id);
    await api.type(text);
  }
  // Codepoints, not UTF-16 units: a non-BMP char reports `keys: 1`, matching the
  // vega and simulator-server backends.
  return { typed: text, keys: [...text].length };
}
