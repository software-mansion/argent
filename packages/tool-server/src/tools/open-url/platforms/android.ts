import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "./ios";

export async function openUrlAndroid(
  _services: OpenUrlServices,
  _params: OpenUrlParams
): Promise<OpenUrlResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "open-url",
    platform: "android",
    hint: 'Use `adb shell am start -a android.intent.action.VIEW -d "<url>"`.',
  });
}
