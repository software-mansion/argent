import type { ServiceRef } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { tvControlRef } from "../../blueprints/tv-control";
import { androidTvControlRef } from "../../blueprints/android-tv-control";

/**
 * Resolve the focus-driven TV control service for a target id, dispatching by
 * platform. Both backends expose the same `TvControlApi`, so the tv-* tools'
 * `execute` bodies are identical regardless of which one answers:
 *   - iOS-shaped UDID  → `TvControl` (Apple TV daemons). The factory rejects a
 *     non-tvOS simulator.
 *   - Android serial   → `AndroidTvControl` (adb-backed). The factory rejects a
 *     non-leanback device.
 *
 * Electron ids have no TV surface; routing them to the Apple ref makes the
 * factory fail with a clear "not a tvOS simulator" message rather than silently
 * picking a backend that can't drive them.
 */
export function tvServiceRef(udid: string): ServiceRef {
  const device = resolveDevice(udid);
  return device.platform === "android" ? androidTvControlRef(device) : tvControlRef(device);
}
