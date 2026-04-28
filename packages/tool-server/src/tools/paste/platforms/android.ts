import type { PasteParams, PasteResult, PasteServices } from "./ios";

export async function pasteAndroid(
  _services: PasteServices,
  _params: PasteParams
): Promise<PasteResult> {
  // Android approach: write text to clipboard via `adb shell` + cmd clipboard,
  // then trigger paste via `adb shell input keyevent KEYCODE_PASTE` or via
  // text input directly with `adb shell input text`.
  throw new Error("paste on Android is not yet implemented (use `adb shell input text`).");
}
