import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { iosImpl } from "./ios";
import type { GesturePinchParams, GesturePinchResult, GesturePinchServices } from "./ios";

// Identical to iOS — both go through `simulator-server`, which itself dispatches
// to iOS or Android based on the udid shape. Re-export the iOS handler.
export const androidImpl: PlatformImpl<
  GesturePinchServices,
  GesturePinchParams,
  GesturePinchResult
> = {
  handler: iosImpl.handler,
};
