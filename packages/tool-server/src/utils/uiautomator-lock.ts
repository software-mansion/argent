import { withKeyedLock } from "./keyed-lock";

// Keyed by adb serial. Overlapping `uiautomator dump`s on one device get one of
// them `Killed`, and a timed-out wait tool leaves its dump running.
const uiautomatorDumpLocks = new Map<string, Promise<unknown>>();

export function withUiautomatorLock<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(uiautomatorDumpLocks, serial, fn);
}
