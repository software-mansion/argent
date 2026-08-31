import type { Registry, ToolContext } from "@argent/registry";
import { invokeSubTool } from "./sub-invoke";
import { LAUNCH_PLATFORMS } from "../tools/flows/flow-utils";

export type ListedPlatform = (typeof LAUNCH_PLATFORMS)[number];

/**
 * The part of a `list-devices` entry the device-resolution paths read. Each
 * platform spells the id differently, hence {@link deviceEntryId}.
 */
export interface ListedDevice {
  platform: ListedPlatform;
  state?: string;
  udid?: string;
  serial?: string;
  id?: string;
}

export function deviceEntryId(d: ListedDevice): string | undefined {
  if (d.platform === "ios") return d.udid;
  if (d.platform === "chromium") return d.id;
  return d.serial; // android, vega
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
  return `${deviceEntryId(d) ?? "?"} (${d.platform}${d.state ? `, ${d.state}` : ""})`;
}

export async function listDevices(
  registry: Registry,
  ctx: ToolContext | undefined
): Promise<ListedDevice[]> {
  const { devices } = (await invokeSubTool(registry, ctx, "list-devices", {})) as {
    devices: ListedDevice[];
  };
  return devices;
}
