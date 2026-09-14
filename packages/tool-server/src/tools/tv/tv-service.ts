import type { Registry, ServiceRef } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { tvControlRef } from "../../blueprints/tv-control";
import { androidTvControlRef } from "../../blueprints/android-tv-control";
import type { TvControlApi } from "../../blueprints/tv-control-types";

/**
 * Resolve the focus-driven TV control service for a target id. Both backends
 * expose the same `TvControlApi`. TV-ness is not checked here: the Apple
 * factory rejects a non-tvOS simulator, the Android one a non-leanback device.
 */
export function tvServiceRef(udid: string): ServiceRef {
  const device = resolveDevice(udid);
  return device.platform === "android" ? androidTvControlRef(device) : tvControlRef(device);
}

/**
 * Resolve the `TvControlApi` through the registry. The focus-driven tools
 * (`describe`, `tv-remote`, `keyboard`) resolve it lazily here rather than in
 * `services()`: telling a TV target apart from a phone is async, and an eager
 * declaration would also spin up the touch/key `simulator-server` blueprint for
 * a tvOS udid it cannot drive.
 */
export async function resolveTvApi(registry: Registry, udid: string): Promise<TvControlApi> {
  const ref = tvServiceRef(udid);
  return typeof ref === "string"
    ? registry.resolveService<TvControlApi>(ref)
    : registry.resolveService<TvControlApi>(ref.urn, ref.options);
}
