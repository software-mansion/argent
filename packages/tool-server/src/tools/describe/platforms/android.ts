import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { DescribeResult } from "../contract";

export async function describeAndroid(_udid: string, _bundleId?: string): Promise<DescribeResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "describe",
    platform: "android",
    hint:
      "Wire `adb -s <serial> exec-out uiautomator dump` + a uiautomator XML parser; " +
      "return a DescribeNode tree matching the iOS shape. Handle keyguard / DRM " +
      "overlays which refuse capture, and use a per-call random temp file under " +
      "/data/local/tmp/ to avoid races between concurrent describes.",
  });
}
