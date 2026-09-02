import type { Registry } from "@argent/registry";
import { invokeSubTool, type SubInvokeContext } from "./sub-invoke";
import { LAUNCH_PLATFORMS } from "../tools/flows/flow-utils";

/**
 * `list-devices` reports every {@link LAUNCH_PLATFORMS} entry plus `ios-remote`,
 * which has no launch path of its own.
 *
 * {@link isBooted} cases all five, so its `default` arm is unreachable for any
 * value of this union — it is there for the entry this type does not describe,
 * a platform added to `list-devices` and not here.
 */
export type ListedPlatform = (typeof LAUNCH_PLATFORMS)[number] | "ios-remote";

/**
 * The part of a `list-devices` entry the device-resolution paths read. Each
 * platform spells the id differently, hence {@link deviceEntryId}.
 */
export interface ListedDevice {
  platform: ListedPlatform;
  state?: string;
  udid?: string;
  // Nullable, not merely absent: a stopped VVD has no serial yet, and
  // `list-devices` passes `VegaDevice` through verbatim.
  serial?: string | null;
  id?: string;
}

export function deviceEntryId(d: ListedDevice): string | undefined {
  if (d.platform === "ios" || d.platform === "ios-remote") return d.udid;
  if (d.platform === "chromium") return d.id;
  return d.serial ?? undefined; // android, vega
}

/**
 * Each platform reports readiness in its own vocabulary. A platform this does
 * not know reads as not-booted, so an unrecognised entry is never auto-selected
 * or bound into a flow.
 */
export function isBooted(d: ListedDevice): boolean {
  switch (d.platform) {
    case "ios":
      return d.state === "Booted";
    // A remote simulator is reachable only through `sim-remote`, and auto-target
    // has never selected one. Reported as not-booted so it is listed but never
    // picked; widening that is its own change.
    case "ios-remote":
      return false;
    case "android":
      return d.state === "device";
    case "vega":
      return d.state === "running" || d.state === "device";
    case "chromium":
      return true; // a discovered chromium device is, by definition, reachable
    default:
      return false;
  }
}

export function describeDevice(d: ListedDevice): string {
  // `||`, not `??`: an id key present but empty renders as nothing at all, and
  // the entry reads as a stray `(ios, Booted)` in a sentence about ids.
  return `${deviceEntryId(d) || "?"} (${d.platform}${d.state ? `, ${d.state}` : ""})`;
}

export async function listDevices(
  registry: Registry,
  ctx: SubInvokeContext | undefined
): Promise<ListedDevice[]> {
  const { devices } = (await invokeSubTool(registry, ctx, "list-devices", {})) as {
    devices: ListedDevice[];
  };
  return devices;
}
