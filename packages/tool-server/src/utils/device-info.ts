import type { DeviceInfo, DeviceKind, Platform } from "@argent/registry";

/**
 * iOS simulator UDID format: 8-4-4-4-12 hex with dashes. Anything else is treated
 * as an Android adb serial. We rely on shape rather than listing devices because
 * `xcrun simctl list` and `adb devices` are slow enough that classifying a hot
 * tool call would dominate its latency. A future enhancement can fall back to
 * listing when shape is ambiguous.
 */
const IOS_UDID_SHAPE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Vega device inventory. Unlike iOS/Android, a Vega serial (e.g.
 * `amazon-4a27df03c9777152`) has no shape that distinguishes it from an Android
 * adb serial, so `classifyDevice` cannot guess it. Instead, Vega discovery
 * (`listVegaDevices`) registers what it found here, and `resolveDevice` consults
 * this map first. The Vega watcher keeps it warm in the running server; tests
 * and one-shot harnesses populate it by calling `list-devices` (or discovery)
 * before any device-targeting Vega tool.
 */
export interface VegaInventoryEntry {
  kind: DeviceKind;
  name?: string;
  state?: string;
}
const vegaInventory = new Map<string, VegaInventoryEntry>();

/**
 * Replace the known set of Vega devices wholesale. Wholesale (not merge) so a
 * device that has since stopped/disconnected stops resolving as Vega instead of
 * lingering forever.
 */
export function registerVegaDevices(
  entries: Array<{ id: string } & VegaInventoryEntry>
): void {
  vegaInventory.clear();
  for (const e of entries) {
    vegaInventory.set(e.id, { kind: e.kind, name: e.name, state: e.state });
  }
}

/** Test-only: clear the Vega inventory between tests. */
export function __resetVegaInventoryForTests(): void {
  vegaInventory.clear();
}

/** Returns the platform a `udid` belongs to. Known Vega serials win over shape. */
export function classifyDevice(udid: string): Platform {
  if (vegaInventory.has(udid)) return "vega";
  return IOS_UDID_SHAPE.test(udid) ? "ios" : "android";
}

/**
 * Build a `DeviceInfo` from a raw udid. Vega devices are resolved from the
 * inventory (carrying their discovered kind/name/state); iOS/Android fill the
 * platform and a default kind ('simulator' for iOS, 'emulator' for Android) —
 * platform impls can enrich with name/state/sdkLevel via simctl/adb if needed.
 */
export function resolveDevice(udid: string): DeviceInfo {
  const vega = vegaInventory.get(udid);
  if (vega) {
    return { id: udid, platform: "vega", kind: vega.kind, name: vega.name, state: vega.state };
  }
  const platform = classifyDevice(udid);
  const kind: DeviceKind = platform === "ios" ? "simulator" : "emulator";
  return { id: udid, platform, kind };
}
