import type { DescribeResult } from "../contract";

/**
 * Android describe path (when implemented):
 *   `adb -s <serial> exec-out uiautomator dump /dev/tty` returns an XML
 *   hierarchy of the current screen. Parse into a `DescribeNode` tree
 *   matching the iOS shape so the agent sees a uniform contract.
 *
 * Edge cases to handle when filling in:
 *   - Locked screen / keyguard (uiautomator can't capture)
 *   - DRM / Play Integrity overlays (capture refused)
 *   - Per-call random temp file path under /data/local/tmp/ to avoid races
 */
export async function describeAndroid(_udid: string, _bundleId?: string): Promise<DescribeResult> {
  throw new Error(
    "describe on Android is not yet implemented. Wire `adb exec-out uiautomator dump` + " +
      "uiautomator XML parser here, then add `android: { emulator: true, device: true, unknown: true }` " +
      "to the tool's capability declaration."
  );
}
