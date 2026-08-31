import type { Registry, ToolContext, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "./device-info";
import { assertSupported } from "./capability";
import { describeDevice, deviceEntryId, isBooted, listDevices } from "./booted-devices";

/**
 * Thrown when a caller omitted `udid` and the server cannot name one device for
 * it. The message always enumerates what IS booted, because that listing is the
 * whole reason the caller would otherwise have had to run `list-devices` first.
 */
export class AutoDeviceTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoDeviceTargetError";
  }
}

/**
 * The single booted device this tool can drive, for a call that named none.
 *
 * Deliberately narrow: it resolves only when exactly ONE booted device passes
 * the tool's own `capability` gate. Two candidates is an ambiguity the server
 * has no basis to break — picking either would send a gesture to a device the
 * caller was not looking at — so it refuses and names them.
 *
 * The capability filter is what makes a mixed pool work: with an iPhone and a
 * Chromium app both up, `chromium-tabs` still resolves, because the iPhone is
 * not a candidate for it.
 */
export async function resolveAutoDeviceTarget(
  registry: Registry,
  ctx: ToolContext | undefined,
  def: ToolDefinition
): Promise<string> {
  const devices = await listDevices(registry, ctx);
  const booted = devices.filter(isBooted);

  const candidates = booted.filter((entry) => {
    const id = deviceEntryId(entry);
    if (!id) return false;
    if (!def.capability) return true;
    try {
      assertSupported(def.id, def.capability, resolveDevice(id));
      return true;
    } catch {
      return false;
    }
  });

  if (candidates.length === 1) {
    // Non-null: deviceEntryId already returned a string for every candidate.
    return deviceEntryId(candidates[0]!)!;
  }

  const listing = devices.length ? devices.map(describeDevice).join(", ") : "none";
  if (candidates.length === 0) {
    throw new AutoDeviceTargetError(
      `No booted device supports \`${def.id}\`, so \`udid\` could not be resolved. ` +
        `Boot one, or pass \`udid\` explicitly. Devices: ${listing}.`
    );
  }
  throw new AutoDeviceTargetError(
    `${candidates.length} booted devices support \`${def.id}\`, so \`udid\` is ambiguous — ` +
      `pass it explicitly. Candidates: ${candidates.map(describeDevice).join(", ")}.`
  );
}
