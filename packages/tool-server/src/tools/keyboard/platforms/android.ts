import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { iosImpl } from "./ios";
import type { KeyboardParams, KeyboardResult, KeyboardServices } from "./ios";

// Android shares the iOS impl byte-for-byte: the `simulator-server android`
// backend accepts the same USB-HID keycodes over stdin. Re-export rather than
// duplicate the keycode tables.
export const androidImpl: PlatformImpl<KeyboardServices, KeyboardParams, KeyboardResult> = {
  handler: iosImpl.handler,
};
