import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { GestureRotateParams, GestureRotateResult, GestureRotateServices } from "./ios";

export async function rotateGestureAndroid(
  _services: GestureRotateServices,
  _params: GestureRotateParams
): Promise<GestureRotateResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "gesture-rotate",
    platform: "android",
    hint:
      "Multi-touch — same constraint as gesture-pinch. Requires UiAutomator " +
      "instrumentation; adb sendevent does not support second-touch coordinates.",
  });
}
