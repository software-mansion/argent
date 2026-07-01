import type { Registry, ServiceRef } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { tvControlRef } from "../../blueprints/tv-control";
import { androidTvControlRef } from "../../blueprints/android-tv-control";
import type { TvControlApi } from "../../blueprints/tv-control-types";

/**
 * Resolve the focus-driven TV control service for a target id, dispatching by
 * platform. Both backends expose the same `TvControlApi`, so callers' code is
 * identical regardless of which one answers:
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

/**
 * Resolve the `TvControlApi` for a target id through the registry, picking the
 * Apple TV or Android TV backend by platform. The focus-driven tools (`describe`,
 * `tv-remote`, `keyboard`) resolve it lazily here (rather than declaring it in
 * `services()`) because telling a TV target apart from a phone is async, and
 * declaring it eagerly would also spin up the touch/key `simulator-server`
 * blueprint for a tvOS udid it cannot drive.
 */
export async function resolveTvApi(registry: Registry, udid: string): Promise<TvControlApi> {
  const ref = tvServiceRef(udid);
  return typeof ref === "string"
    ? registry.resolveService<TvControlApi>(ref)
    : registry.resolveService<TvControlApi>(ref.urn, ref.options);
}
