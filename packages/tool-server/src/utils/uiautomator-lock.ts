import { withKeyedLock } from "./keyed-lock";

// Keyed by adb serial. Android runs one `uiautomator dump` per device at a
// time: a second one started while another runs gets one of them `Killed`.
// A wait tool that times out leaves its dump running, so the next read must
// queue behind it.
const uiautomatorDumpLocks = new Map<string, Promise<unknown>>();

export function withUiautomatorLock<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(uiautomatorDumpLocks, serial, fn);
}
