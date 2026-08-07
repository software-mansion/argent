import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { Registry, ToolDependency } from "@argent/registry";
import type { DescribeTreeData } from "../../contract";
import { adbExecOutBinary, isAndroidTv } from "../../../../utils/adb";
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
        // clearCache: every reader of this tree is answering "what is on the
        // screen right now" — the `describe` tool, `await-screen-idle`,
        // `await-ui-element` and the Lens/preview describe route all read it,
        // and a selector match turns it into tap coordinates. The helper's
        // long-lived connection caches AccessibilityNodeInfo per node, and only
        // an accessibility content-change event from the app invalidates an
        // entry. An app that emits none for a node — a running stopwatch is the
        // reproducible case — leaves that entry valid forever, and the cached
        // read keeps serving its first-seen text while the screen moves on. It
        // takes no app restart: measured on a freshly-opened connection, 20
        // cached reads across 30 s all returned 2:09.32 against a timer that had
        // reached 2:40.32.
        //
        // The cost scales with the tree, because dropping the cache means the
        // walk re-fetches every node over binder. Measured device-side on arm64
        // emulators: API 30 is linear at 0.28-0.31 ms/node from 330 to 4080
        // nodes; API 34 runs 0.34-0.82 ms/node between 315 and 3065 nodes.
        // Clearing in a single UiAutomation.clearCache() call at API 34+ does
        // not make it the cheaper platform — it costs more than API 30's
        // per-node refresh() at every size from 315 nodes up.
        //
        // On the polled readers that cost lands as a verdict, not just latency.
        // They bound each fetch by the budget they were given and do not overrun
        // it, but settling takes two samples that agree, so a tree too slow to
        // read twice starves them of the second one. Both report that as a note
        // rather than as a negative answer about the screen; see
        // `samples` in poll-describe-tree.
        devtools.getHierarchy({ clearCache: true }),
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
  return { tree, source: "uiautomator", hint };
}
