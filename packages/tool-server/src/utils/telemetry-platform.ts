import type { Platform as DevicePlatform } from "@argent/registry";
import type { Platform as TelemetryPlatform } from "@argent/telemetry";
import { classifyDevice } from "./device-info";
import { getCachedSimulatorRuntimeKind } from "./ios-devices";
import { getCachedAndroidRuntimeKind } from "./adb";

export type { TelemetryPlatform };

/**
 * Split a TV target out of its base mobile platform for telemetry, using only
 * the already-memoized runtime kind — never a fresh `simctl`/`adb` probe, since
 * this runs on hot paths (the per-tool-call path in http.ts and the per-round
 * Lens-funnel path). A tvOS simulator and an iPhone simulator share the same
 * UDID shape (both classify as `ios`); an Android TV emulator and a phone share
 * the `emulator-NNNN` serial shape (both `android`). The device platform stays
 * coarse (a TV is a `runtimeKind`, not its own device platform — capability
 * gating and dispatch are TV-agnostic); we refine it to `tvos` / `android-tv`
 * here for reporting only when the cache already knows the kind, and leave it
 * coarse otherwise. The first tool call on a device may land before the cache is
 * warm and report the base platform; subsequent calls, once a
 * describe/interaction path has warmed the runtime-kind cache (the per-platform
 * warmers are listed on `getCachedSimulatorRuntimeKind` /
 * `getCachedAndroidRuntimeKind`), report the TV variant.
 */
export function refineTvPlatform(
  basePlatform: DevicePlatform,
  deviceId: string
): TelemetryPlatform {
  if (basePlatform === "ios" && getCachedSimulatorRuntimeKind(deviceId) === "tv") {
    return "tvos";
  }
  if (basePlatform === "android" && getCachedAndroidRuntimeKind(deviceId) === "tv") {
    return "android-tv";
  }
  return basePlatform;
}

/**
 * Telemetry platform for a raw device id, refining a TV target to `tvos` /
 * `android-tv` when the runtime-kind cache is warm (coarse `ios` / `android`
 * until then). Used by the Lens funnel events (`lens:preview_opened`,
 * `lens:round_completed`, `lens:round_abandoned`) so a Lens session on a TV
 * device is attributed the same way #477 attributes the generic `tool:*` events.
 * Without it a Lens round against an Apple TV simulator would report `ios` on
 * the lens events while the very same session's tool calls report `tvos`,
 * reintroducing exactly the TV attribution blindness #477 removed.
 */
export function classifyDeviceForTelemetry(deviceId: string): TelemetryPlatform {
  return refineTvPlatform(classifyDevice(deviceId), deviceId);
}
