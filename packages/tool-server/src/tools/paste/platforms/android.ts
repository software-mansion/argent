import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../../blueprints/simulator-server";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../../utils/capability";
import { isAndroidTv } from "../../../utils/adb";
import { injectAndroidKeycode } from "../../../utils/android-input";
import { setSimulatorClipboardText } from "../../../utils/simulator-client";
import type { PasteParams, PasteResult, PasteServices } from "../types";

/** `android.view.KeyEvent.KEYCODE_PASTE` — a dedicated paste key every `TextView` honours. */
const KEYCODE_PASTE = 279;

/**
 * The clipboard is filled through simulator-server's emulator gRPC bridge, and
 * the paste is a single `KEYCODE_PASTE` over `adb shell input` — the same
 * transport the keyboard tool uses, because the emulator drops HID key events
 * on `hw.keyboard = no` AVDs (issue #449) and a meta-key chord is not handled
 * by the emulator's HID path at all.
 */
export function makeAndroidImpl(
  registry: Registry
): PlatformImpl<PasteServices, PasteParams, PasteResult> {
  return {
    requires: ["adb"],
    async handler(_services, params, device: DeviceInfo) {
      // An Android TV emulator is `android` / `emulator` by serial shape, so
      // the matrix admits it; a leanback UI is focus-driven and its fields are
      // typed into with `keyboard`.
      if (await isAndroidTv(device.id)) {
        throw new UnsupportedOperationError(
          "paste",
          device,
          "Android TV is focus-driven — type into the focused field with keyboard instead"
        );
      }
      const ref = simulatorServerRef(device);
      const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
      await setSimulatorClipboardText(api, params.text);
      await injectAndroidKeycode(device.id, KEYCODE_PASTE);
      return { pasted: true };
    },
  };
}
