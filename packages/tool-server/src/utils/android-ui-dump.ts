/**
 * Read the current view hierarchy off an Android device as `uiautomator` XML.
 *
 * Single-sourced because the transport has a sharp edge that is easy to get
 * wrong: the widely-quoted `uiautomator dump /dev/tty` trick does NOT work
 * through `adb shell`. `adb -s <serial> shell <cmd>` runs the command with no
 * usable controlling terminal, so uiautomator's write to `/dev/tty` goes
 * nowhere and stdout carries only its status line — while still exiting 0, so
 * the caller sees a *successful* 33-byte reply and no hierarchy:
 *
 *     $ adb -s emulator-5554 shell   'uiautomator dump /dev/tty'   # 33 bytes
 *     UI hierchary dumped to: /dev/tty
 *     $ adb -s emulator-5554 exec-out 'uiautomator dump /dev/tty'  # 27622 bytes
 *     <?xml version='1.0' …><hierarchy …>
 *
 * (Measured on API 30 and API 36.) A caller that reads the hierarchy through
 * `adbShell` therefore silently parses an empty tree forever, which is why this
 * lives in one place rather than being re-derived per call site.
 *
 * The dump goes to a per-call file under /data/local/tmp rather than to
 * `/dev/tty`, so it does not depend on that trick at all: concurrent dumps on
 * the same serial would otherwise race on the shared /sdcard/window_dump.xml
 * (one call's `cat` reading the other's write mid-flight). `uiautomator` rejects
 * unwritable paths, and /data/local/tmp is world-writable on every Android we
 * support.
 */
import { adbExecOutBinary } from "./adb";

// `--compressed` strips nodes that `isImportantForAccessibility()` would skip
// (decorative wrappers, RN SVG sub-paths, bounds-less Compose group containers)
// while preserving every text label, content-desc, clickable, resource-id and
// focus/password flag an accessibility service would surface — i.e. everything
// any caller here reads. Empirically cuts a Bluesky thread dump from 65 KB → 23 KB.
const DUMP_COMMAND_FLAGS = "--compressed";

/** Default budget for one dump. A cold `uiautomator` on a busy emulator is slow. */
const ANDROID_UI_DUMP_TIMEOUT_MS = 20_000;

/**
 * `uiautomator dump` on `serial`, returned as UTF-8 XML.
 *
 * Throws only on a transport failure (adb error / timeout). A dump that the
 * device refused (locked screen, secure overlay) comes back as an `ERROR:` line
 * instead of a `<hierarchy>`; callers differ in how loudly they report that, so
 * the check is left to them.
 */
export async function dumpAndroidUiXml(
  serial: string,
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const dumpPath = `/data/local/tmp/argent-ui-dump-${suffix}.xml`;
  // Trailing `; rm -f` (not `&& rm -f`) so the cleanup fires even when `dump` or
  // `cat` fails — keyguard/MFA flaps used to leak a dump file per attempt.
  const raw = await adbExecOutBinary(
    serial,
    `uiautomator dump ${DUMP_COMMAND_FLAGS} ${dumpPath} >/dev/null && cat ${dumpPath}; rm -f ${dumpPath}`,
    { timeoutMs: options.timeoutMs ?? ANDROID_UI_DUMP_TIMEOUT_MS }
  );
  return raw.toString("utf-8");
}
