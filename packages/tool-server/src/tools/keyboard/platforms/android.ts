import type { KeyboardParams, KeyboardResult, KeyboardServices } from "./ios";

export async function keyboardAndroid(
  _services: KeyboardServices,
  _params: KeyboardParams
): Promise<KeyboardResult> {
  // Android approach: `adb shell input text "..."` for char streams,
  // `adb shell input keyevent <KEYCODE_*>` for named keys.
  throw new Error(
    "keyboard on Android is not yet implemented (use `adb shell input text` / `input keyevent`)."
  );
}
