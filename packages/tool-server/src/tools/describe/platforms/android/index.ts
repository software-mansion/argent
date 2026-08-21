import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { Registry, ToolDependency } from "@argent/registry";
import type { DescribeTreeData } from "../../contract";
import { isAndroidTv } from "../../../../utils/adb";
import { dumpAndroidUiXml } from "../../../../utils/android-ui-dump";
import { resolveDevice } from "../../../../utils/device-info";
import { getAndroidScreenSize } from "../../../../utils/android-screen";
import { parseUiAutomatorDump } from "./uiautomator-parser";
import {
  androidDevtoolsRef,
  type AndroidDevtoolsApi,
} from "../../../../blueprints/android-devtools";

export const androidRequires: ToolDependency[] = ["adb"];

// Android TV is focus-driven: the uiautomator tree is still readable (so we
// don't short-circuit describe the way iOS does for tvOS), but the agent
// shouldn't tap coordinates — it should move the D-pad focus instead. Surface
// the tv-* tools as a hint rather than blocking the (still-useful) tree.
const ANDROID_TV_HINT =
  "This is an Android TV (leanback) device — it is focus-driven and has no touch. " +
  "Prefer the `describe` tool to read the focused / focusable elements, `tv-remote` " +
  "(up/down/left/right/select/back/menu/home) to move focus, and `keyboard` to type, " +
  "rather than coordinate taps.";

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
  _bundleId?: string,
  // When the caller already resolved the form factor (the `describe` dispatch
  // and the TV fallback both call `isAndroidTv` before reaching here), thread
  // that verdict in so we don't re-probe — `getAndroidRuntimeKind` still costs
  // an `adb devices` + avdName getprop per call even on a cache hit, and
  // `describe` is an alwaysLoad hot path. `undefined` means "unknown, probe".
  isTv?: boolean
): Promise<DescribeTreeData> {
  // Attach the TV hint on both the devtools and legacy uiautomator return paths.
  const hint = (isTv ?? (await isAndroidTv(serial))) ? ANDROID_TV_HINT : undefined;

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
      return { tree, source: "android-devtools", hint };
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
  // Transport and dump-path handling live in `utils/android-ui-dump` so every
  // reader of the hierarchy shares one (exec-out) implementation — see there
  // for why `adb shell` cannot be used for this.
  const [size, raw] = await Promise.all([getAndroidScreenSize(serial), dumpAndroidUiXml(serial)]);
  const trimmed = raw.trim();
  // No `<hierarchy>` means the capture did not happen, whatever the device said
  // about it. `ERROR: …` is the usual wording, but not the only one: a dump that
  // loses the race for the device's single UiAutomation connection comes back as
  // a bare `Killed` (adb still exits 0) — measured by running three concurrent
  // dumps, and now reachable more often because the keyboard clear is a third
  // caller. Testing for the hierarchy instead of for error wording covers both,
  // and keeps this from falling through to the parser, which would report the
  // far less actionable "failed to parse" for what is really "try again".
  if (!trimmed.includes("<hierarchy")) {
    throw new FailureError(
      // Capped: the device's own bytes are interpolated into an agent-facing
      // message, and a refused screen's output is neither bounded nor ours. Same
      // 200 the TV blueprint applies to this same dump.
      `uiautomator could not capture the screen: ${trimmed.slice(0, 200) || "(no output)"}. ` +
        `Common causes: device locked / keyguard, DRM or secure overlay, Play Integrity screen, ` +
        `or another uiautomator dump holding the device. ` +
        `Retry once — a lost race clears once the holder finishes — then unlock the device or ` +
        `take a screenshot as a fallback.`,
      {
        // The adb wrapper exits 0 while the uiautomator tool it ran produced no
        // hierarchy: an in-band `ERROR:` line, or the bare `Killed` of a lost
        // UiAutomation race. Either is a functional failure of the uiautomator
        // subprocess, so `subprocess` matches the sibling
        // ANDROID_UIAUTOMATOR_PARSE_FAILED (also adb-exit-0, unusable output).
        error_code: FAILURE_CODES.ANDROID_UIAUTOMATOR_CAPTURE_FAILED,
        failure_stage: "android_uiautomator_capture",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  }
  const tree = parseUiAutomatorDump(raw, size.width, size.height);
  return { tree, source: "uiautomator", hint };
}
