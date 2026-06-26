import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { Registry, ToolDependency } from "@argent/registry";
import type { DescribeTreeData } from "../../contract";
import { adbExecOutBinary } from "../../../../utils/adb";
import { resolveDevice } from "../../../../utils/device-info";
import { getAndroidScreenSize } from "../../../../utils/android-screen";
import { parseUiAutomatorDump } from "./uiautomator-parser";
import {
  androidDevtoolsRef,
  type AndroidDevtoolsApi,
} from "../../../../blueprints/android-devtools";

export const androidRequires: ToolDependency[] = ["adb"];

/**
 * Try the persistent `android-devtools` helper first; on any error fall back
 * to the legacy `uiautomator dump` path. The fallback exists because the
 * legacy path has independent failure modes (it can survive an APK install
 * rejection, a process spawn failure, an adb-forward conflict) and continues
 * to work for users on locked-down devices that block `adb install -t`.
 */
export async function describeAndroid(
  registry: Registry | undefined,
  serial: string,
  _bundleId?: string
): Promise<DescribeTreeData> {
  if (registry) {
    try {
      // The android-devtools helper is driven entirely over adb, so it works the
      // same on an emulator or a physical device; resolve the real kind anyway so
      // the handle is accurate (and so a physical serial isn't mislabelled).
      const device = resolveDevice(serial);
      const ref = androidDevtoolsRef(device);
      const devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
      const [{ xml }, size] = await Promise.all([
        devtools.getHierarchy(),
        devtools.getScreenSize(),
      ]);
      const tree = parseUiAutomatorDump(xml, size.width, size.height);
      return { tree, source: "android-devtools" };
    } catch (serviceErr) {
      // Fall through to the legacy uiautomator path. Every error here is
      // recoverable because the legacy path has independent failure modes.
      // Surface at debug level so the failure is observable without leaking
      // into the per-call result.

      console.debug(
        `[describe.android] devtools service failed, falling back to uiautomator dump: ${
          serviceErr instanceof Error ? serviceErr.message : String(serviceErr)
        }`
      );
    }
  }

  // ── Legacy uiautomator dump fallback ───────────────────────────────────
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
    getAndroidScreenSize(serial),
    adbExecOutBinary(
      serial,
      `uiautomator dump --compressed ${dumpPath} >/dev/null && cat ${dumpPath}; rm -f ${dumpPath}`,
      { timeoutMs: 20_000 }
    ),
  ]);
  const raw = rawBuf.toString("utf-8");
  const trimmed = raw.trim();
  if (/^ERROR:/i.test(trimmed) || (!trimmed.includes("<hierarchy") && /error/i.test(trimmed))) {
    throw new FailureError(
      `uiautomator could not capture the screen: ${trimmed}. ` +
        `Common causes: device locked / keyguard, DRM or secure overlay, Play Integrity screen. ` +
        `Unlock the device or take a screenshot as a fallback.`,
      {
        // The adb wrapper exits 0, but the uiautomator tool it ran reported an
        // in-band `ERROR:` line — a functional failure of the uiautomator
        // subprocess. Classified `subprocess` to match the sibling
        // ANDROID_UIAUTOMATOR_PARSE_FAILED (also adb-exit-0, unusable output).
        error_code: FAILURE_CODES.ANDROID_UIAUTOMATOR_CAPTURE_FAILED,
        failure_stage: "android_uiautomator_capture",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  }
  const tree = parseUiAutomatorDump(raw, size.width, size.height);
  return { tree, source: "uiautomator" };
}
