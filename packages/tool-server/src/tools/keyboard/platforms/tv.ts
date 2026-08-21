import type { DeviceInfo, Registry } from "@argent/registry";
import { UnsupportedOperationError } from "../../../utils/capability";
import { resolveTvApi } from "../../tv/tv-service";
import type { KeyboardParams, KeyboardResult } from "../types";

// TV typing goes through the focus-driven tv-control backend (injected HID
// keyboard on Apple TV, `adb input text` on Android TV). Named keys are
// navigation on a TV, which belongs to `tv-remote` — so they're rejected here.
// Shared by the ios (Apple TV) and android (Android TV) branches.
//
// No read-back verification here, unlike the Android phone / tablet path (see
// platforms/android-verify.ts). Android TV shares that path's `adb input text`
// sink and so shares its exposure: the TV backend splits only on spaces
// (android-tv-control.ts), so a multi-word string arrives as several short
// bursts, but a space-free one — an email address, a username, a URL, which is
// most of what a TV login box takes — is still injected as a single burst that a
// re-rendering field can drop characters from. It is not verified here because
// this function is shared with Apple TV, whose HID transport cannot read a field
// back at all, so covering Android TV means adding a platform branch to a
// function that deliberately has none, and because the reported defect was on a
// phone. A TV `keyboard` result therefore carries no `verified` — absent means
// "not checked", never "checked and fine".
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
  // Count by codepoint (not UTF-16 units) so a non-BMP char reports `keys: 1`,
  // matching the vega and simulator-server keyboard backends.
  return { typed: text, keys: [...text].length };
}
