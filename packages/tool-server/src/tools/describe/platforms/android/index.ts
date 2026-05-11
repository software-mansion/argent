import type { ToolDependency } from "@argent/registry";
import type { DescribeResult } from "../../contract";
import { adbExecOutBinary } from "../../../../utils/adb";
import { getAndroidScreenSize } from "../../../../utils/android-screen";
import { parseUiAutomatorDump } from "./uiautomator-parser";

export const androidRequires: ToolDependency[] = ["adb"];

export async function describeAndroid(udid: string, _bundleId?: string): Promise<DescribeResult> {
  // Per-call dump path so concurrent describes on the same serial don't race
  // on /sdcard/window_dump.xml (one call's cat would read the other's dump
  // mid-write). `uiautomator` rejects unwritable paths, so we target
  // /data/local/tmp/ which is world-writable on every Android we support.
  const randomSuffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const dumpPath = `/data/local/tmp/argent-ui-dump-${randomSuffix}.xml`;
  // `--compressed` strips nodes that `isImportantForAccessibility()` would skip
  // (decorative wrappers, RN SVG sub-paths, bounds-less Compose group containers)
  // while preserving every text label, content-desc, clickable, and resource-id
  // an accessibility service would surface — i.e. exactly what the agent contract
  // already cares about. Empirically cuts a Bluesky thread dump from 65 KB → 23 KB
  // and 181 → 64 nodes with zero loss of useful info.
  // Trailing `; rm -f` (not `&& rm -f`) so the cleanup fires even when `dump`
  // or `cat` fails — keyguard/MFA flaps used to leak a dump file per attempt.
  const [size, rawBuf] = await Promise.all([
    getAndroidScreenSize(udid),
    adbExecOutBinary(
      udid,
      `uiautomator dump --compressed ${dumpPath} >/dev/null && cat ${dumpPath}; rm -f ${dumpPath}`,
      { timeoutMs: 20_000 }
    ),
  ]);
  const raw = rawBuf.toString("utf-8");
  const trimmed = raw.trim();
  if (/^ERROR:/i.test(trimmed) || (!trimmed.includes("<hierarchy") && /error/i.test(trimmed))) {
    throw new Error(
      `uiautomator could not capture the screen: ${trimmed}. ` +
        `Common causes: device locked / keyguard, DRM or secure overlay, Play Integrity screen. ` +
        `Unlock the device or take a screenshot as a fallback.`
    );
  }
  const tree = parseUiAutomatorDump(raw, size.width, size.height);
  return { tree, source: "uiautomator" };
}
