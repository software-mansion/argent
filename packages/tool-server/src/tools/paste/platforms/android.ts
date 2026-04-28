import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PasteParams, PasteResult, PasteServices } from "./ios";

export async function pasteAndroid(
  _services: PasteServices,
  _params: PasteParams
): Promise<PasteResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "paste",
    platform: "android",
    hint:
      'Use `adb shell input text "<text>"` for direct text injection, or write to ' +
      "the clipboard via `cmd clipboard` and dispatch KEYCODE_PASTE (279) into the " +
      "focused field.",
  });
}
