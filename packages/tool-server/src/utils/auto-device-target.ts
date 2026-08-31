import type { Registry, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "./device-info";
import { assertSupported } from "./capability";
import { describeDevice, deviceEntryId, isBooted, listDevices } from "./booted-devices";

/**
 * Thrown when a caller omitted `udid` and the server cannot name one device for
 * it. The message always enumerates the devices, booted or not, because that
 * listing is the whole reason the caller would otherwise have had to run
 * `list-devices` first — and a shut-down one is what they most likely meant.
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
 *
 * It narrows by platform and kind only. A tool that accepts Apple simulators
 * accepts an Apple TV one, since a UDID does not say which it is — `tv-remote`
 * and the gesture tools sort that out at call time (see tools/tv-remote), so on
 * a machine booting both a TV and a phone the caller still has to name one.
 */
export async function resolveAutoDeviceTarget(
  registry: Registry,
  def: ToolDefinition,
  signal?: AbortSignal
): Promise<string> {
  // No `ToolContext` yet — it carries an ArtifactStore the request builds later —
  // so the signal is passed on its own, which is the only part cancellation needs.
  const devices = await listDevices(registry, undefined, signal);
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
    // Without this an entry the listing prints as `Booted` sits directly under
    // "no booted device", and the caller has no way to tell why it was passed
    // over.
    const remoteNote = devices.some((d) => d.platform === "ios-remote" && d.state === "Booted")
      ? " A remote simulator is never resolved automatically — name one by id to use it."
      : "";
    throw new AutoDeviceTargetError(
      `No booted device runs \`${def.id}\`, so \`udid\` could not be resolved. ` +
        `Boot one, or pass \`udid\` explicitly. Devices: ${listing}.${remoteNote}`
    );
  }
  throw new AutoDeviceTargetError(
    `\`udid\` is ambiguous: ${candidates.length} booted devices match the platforms ` +
      `\`${def.id}\` declares — pass one explicitly. ` +
      `Candidates: ${candidates.map(describeDevice).join(", ")}.`
  );
}
