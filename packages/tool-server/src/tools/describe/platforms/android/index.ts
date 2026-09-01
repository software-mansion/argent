import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { Registry, ToolDependency } from "@argent/registry";
import type { DescribeTreeData } from "../../contract";
import { adbExecOutBinary, isAndroidTv } from "../../../../utils/adb";
import { resolveDevice } from "../../../../utils/device-info";
import {
  getAndroidScreenSize,
  orientScreenSize,
  parseDumpRotation,
} from "../../../../utils/android-screen";
import { parseUiAutomatorDump } from "./uiautomator-parser";
import {
  androidDevtoolsRef,
  type AndroidDevtoolsApi,
} from "../../../../blueprints/android-devtools";

export const androidRequires: ToolDependency[] = ["adb"];

// Android TV keeps a readable uiautomator tree (unlike tvOS, which describe
// short-circuits), so point at the focus-driven tools instead of blocking it.
const ANDROID_TV_HINT =
  "This is an Android TV (leanback) device — it is focus-driven and has no touch. " +
  "Prefer the `describe` tool to read the focused / focusable elements, `tv-remote` " +
  "(up/down/left/right/select/back/menu/home) to move focus, and `keyboard` to type, " +
  "rather than coordinate taps.";

/**
 * Tries the `android-devtools` helper, falling back to `uiautomator dump` on any
 * error: the legacy path fails independently (APK install rejection, helper
 * spawn failure, adb-forward conflict) and still works on locked-down devices
 * that block `adb install -t`.
 */
export async function describeAndroid(
  registry: Registry | undefined,
  serial: string,
  _bundleId?: string,
  // Verdict from a caller that already probed: `getAndroidRuntimeKind` shells out
  // to `adb devices` even on a cache hit and `describe` is an alwaysLoad hot
  // path. `undefined` means "unknown, probe".
  isTv?: boolean
): Promise<DescribeTreeData> {
  const hint = (isTv ?? (await isAndroidTv(serial))) ? ANDROID_TV_HINT : undefined;

  if (registry) {
    try {
      const device = resolveDevice(serial);
      const ref = androidDevtoolsRef(device);
      const devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
      const [{ xml }, size] = await Promise.all([
        // clearCache: every reader of this tree is answering "what is on the
        // screen right now" — the `describe` tool and its Android TV branch,
        // `await-screen-idle`, `await-ui-element`, the shared selector match
        // (which becomes tap coordinates) and the Lens/preview route all reach
        // the helper through here. The helper's long-lived connection caches
        // AccessibilityNodeInfo per node, and only an accessibility
        // content-change event from the app invalidates an entry. An app that
        // emits none for a node — a running stopwatch is the reproducible case —
        // leaves that entry valid forever, and the cached read keeps serving its
        // first-seen text while the screen moves on. It takes no app restart:
        // measured on a freshly-opened connection, 20 cached reads across 30 s
        // all returned 2:09.32 against a timer that had reached 2:40.32.
        //
        // The cost scales with the tree, since dropping the cache makes the walk
        // re-fetch every node over binder; `GetHierarchyOptions.clearCache` in
        // the blueprint carries the per-node measurements. On the polled readers
        // that cost lands as a verdict, not just latency: they bound each fetch
        // by the budget they were given, so a tree too slow to read leaves them
        // fewer samples than their verdict needs. Both say so in a note rather
        // than let the verdict stand unqualified; see `samples` in
        // poll-describe-tree.
        devtools.getHierarchy({ clearCache: true }),
        devtools.getScreenSize(),
      ]);
      const tree = parseUiAutomatorDump(xml, size.width, size.height);
      return { tree, source: "android-devtools", hint };
    } catch (serviceErr) {
      // Debug level: the legacy path below is expected to recover, so this
      // shouldn't leak into the per-call result.

      console.debug(
        `[describe.android] devtools service failed, falling back to uiautomator dump: ${
          serviceErr instanceof Error ? serviceErr.message : String(serviceErr)
        }`
      );
    }
  }

  // Per-call dump path so concurrent describes on the same serial don't cat each
  // other's half-written dump.
  const randomSuffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const dumpPath = `/data/local/tmp/argent-ui-dump-${randomSuffix}.xml`;
  // `--compressed` skips nodes `isImportantForAccessibility()` drops (decorative
  // wrappers, RN SVG sub-paths, bounds-less Compose containers) while keeping the
  // text, content-desc, clickable and resource-id the agent contract uses.
  // `;` rather than `&&` before `rm -f` so cleanup fires even when dump/cat fails.
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
        // adb exits 0, but uiautomator reported an in-band `ERROR:` line — same
        // adb-exit-0/unusable-output shape as ANDROID_UIAUTOMATOR_PARSE_FAILED.
        error_code: FAILURE_CODES.ANDROID_UIAUTOMATOR_CAPTURE_FAILED,
        failure_stage: "android_uiautomator_capture",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  }
  // `wm size` is not rotation-aware, but the dump says which rotation it was
  // taken at. Orienting the divisor here is what keeps a rotated device's frames
  // in the same upright space the android-devtools path already produces — and
  // stops the right-hand half of a landscape screen being pruned away as
  // off-screen (#609).
  const oriented = orientScreenSize(size, parseDumpRotation(raw));
  const tree = parseUiAutomatorDump(raw, oriented.width, oriented.height);
  return { tree, source: "uiautomator", hint };
}
