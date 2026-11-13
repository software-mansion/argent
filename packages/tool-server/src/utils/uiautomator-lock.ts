import { adbCommandPrefix } from "./adb-server";
import { withKeyedLock } from "./keyed-lock";

// Keyed by adb serial. Overlapping `uiautomator dump`s on one device get one of
// them `Killed`, and a timed-out wait tool leaves its dump running.
const uiautomatorDumpLocks = new Map<string, Promise<unknown>>();

export function withUiautomatorLock<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(uiautomatorDumpLocks, serial, fn);
}

/**
 * The remedy for a dump the system killed, or undefined when `output` is not
 * one. `uiautomator` can't register its UiAutomation connection while another
 * client holds one, and the system kills it.
 */
export function uiautomatorKilledMessage(output: string): string | undefined {
  if (!/\bKilled\b/.test(output)) return undefined;
  return (
    `uiautomator could not capture the screen: ${output}. Another UiAutomation client ` +
    `(the argent devtools helper, or a test runner such as Espresso or Appium) holds ` +
    `the accessibility connection. Stop it, for the helper with ` +
    `\`${adbCommandPrefix(process.env)}adb shell am force-stop com.argent.androiddevtools\`, ` +
    `and try again.`
  );
}
